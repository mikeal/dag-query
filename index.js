import Libp2p from 'libp2p'
import WebSockets from 'libp2p-websockets'
import libp2pNoise from 'libp2p-noise'
import MPLEX from 'libp2p-mplex'
import itpipe from 'it-pipe'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { decode as decodeBlock, encode as encodeBlock } from 'multiformats/block'

const { NOISE } = libp2pNoise
const { pipe } = itpipe

const modules = {
  transport: [WebSockets],
  connEncryption: [NOISE],
  streamMuxer: [MPLEX]
}

class BlockSwap {
  constructor (store) {
    this.store = store
  }
  async * query (request) {
    let { get } = request
    yield { block: await this.store.get(get) }
  }
  static async * encodeRequest (request) {
    yield codec.encode(request)
  }
}

const queryClasses = {
  'blockswap': BlockSwap
}

const decode = chunk => decodeBlock({ hasher, codec, bytes: chunk.subarray() })
const encode = value => encodeBlock({ hasher, codec, value })

const msg = {
  end: {
    encode: async function * () {
      yield new Uint8Array([ 1 ])
    }
  },
  block: {
    encode: async function * (value) {
      console.log('encode')
      const { cid, bytes } = await encode(value)
      yield new Uint8Array([ 0 ])
      yield new Uint8Array([ cid.bytes.byteLength ])
      yield cid.bytes
      yield bytes
      console.log('written')
    },
    decode: async chunk => {
      const length = chunk.get(0)
      const cid = CID.parse(chunk.slice(1, length + 1))
      const bytes = chunk.slice(1 + length)
      // TODO: lookup hasher and decoder to support more than cbor
      const block = await decodeBlock(bytes)
      if (!cid.equals(block.cid)) {
        throw new Error('CID does not match block')
      }
      return block
    }
  }
}

const encodeMessage = ({ block, end }) => {
  if (block) return msg.block.encode(block)
  if (end) return msg.end.encode()
  throw new Error('Unknown message type')
}
const decodeMessage = chunk => {
  chunk = chunk instanceof Uint8Array ? chunk : chunk.slice()
  const [ type ] = chunk
  if (type === 0) return msg.block.decode(chunk.subarray(1))
  if (type === 1) return { end: true }
  throw new Error('Unknown message type')
}

class Protocol {
  constructor ({ stream, queries }) {
    this.stream = stream
    if (!queries) throw new Error('forgot queries')
    this.queries = queries
    if (stream) this.runner = this.onStream(stream)
    else this.service = true
  }
  async * query (request) {
    // TODO: we can hang other to player properties off this
    // structure for cids to ignore and other cache features
    // that can be implemented on top of the query side
    const { blockswap } = request
    if (blockswap) {
      yield * this.queries.blockswap.query(blockswap)
      return
    }
    throw new Error('Unknown query type')
  }
  async onStream (stream) {
    for await (const chunk of stream.source) {
      if (this.service) {
        const value = codec.decode(chunk.slice())
        for await (const msg of this.query(value)) {
          pipe(encodeMessage(msg), stream)
        }
        pipe(encodeMessage({ end: true }), stream)
      } else {
        const resp = await decodeMessage(chunk)
        console.log(1, {resp})
      }
    }
    if (this._onStreamResolve) {
      this._onStreamResolve()
    }
  }
  static handler (node, queries) {
    const protocol = new Protocol({ queries })
    node.handle(`/dag-query/0.0.0`, ( { stream } ) => {
      protocol.stream = stream
      protocol.onStream(stream)
    })
    return protocol
  }
  request (name, request) {
    const CLS = queryClasses[name]
    if (!CLS) throw new Error(`No query class named "${name}"`)
    return new Promise(async (resolve, reject) => {
      const iter = CLS.encodeRequest(request)
      if (!this.stream) {
        throw new Error('No stream attached to protocol.')
      }
      pipe(iter, this.stream, async source => {
        try {
          for await (const data of source) {
            console.log({data})
          }
        } catch (e) {
          return reject(e)
        }
        resolve('done')
      })
    })
  }
}
Protocol.version = '0.0.0'

const protocols = {}
const addProtocol = (CLS) => {
  protocols[CLS.version] = CLS
}
addProtocol(Protocol)

const protocolVersions = () => Object.keys(protocols).map(p => `/dag-query/${p}`)

const { fromEntries, entries } = Object

class Node {
  constructor ({ conf, store }) {
    this.conf = conf
    this.queries = fromEntries(entries(queryClasses).map(([k, Cls]) => [ k, new Cls(store) ]))
    this.connections = {}
  }
  async serve () {
    if (this.node) throw new Error('Cannot serve after node is instantiated')

    // TODO: pull protocols and ports from conf
    this.node = await Libp2p.create({
      addresses: {
        listen: ['/ip4/127.0.0.1/tcp/8000/ws']
      },
      modules
    })

    const protocol = Protocol.handler(this.node, this.queries)
    // start libp2p
    await this.node.start()
    return this.node.multiaddrs.map(addr => `${addr.toString()}/p2p/${this.node.peerId.toB58String()}`)
  }
  async connect (addr) {
    if (!this.node) {
      this.node = await Libp2p.create({ modules })
    }
    let conn
    if (!this.connections[addr]) {
      conn = await this.node.dial(addr)
      // conn.on('end', () => console.log('end', addr))
      // conn.on('close', () => console.log('close', addr))
      this.connections[addr] = conn
    } else {
      conn = this.connections[addr]
    }
    const { stream, protocol } = await conn.newStream(protocolVersions())
    const [,, name] = protocol.split('/')
    const Cls = protocols[name]
    return new Cls({ stream, queries: this.queries })
  }
  async * request (addr, name, request) {
    const protocol = await this.connect(addr)
    yield * protocol.request(name, request)
  }
  stop () {
    return this.node.stop()
  }
  static create ({ store }) {
    return new Node({ store })
  }
}

export default Node
