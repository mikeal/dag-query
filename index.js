import net from 'net'
import bl from 'bl'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { decode as decodeBlock, encode as encodeBlock } from 'multiformats/block'

const enc32 = value => {
  value = +value
  const buff = new Uint8Array(4)
  buff[3] = (value >>> 24)
  buff[2] = (value >>> 16)
  buff[1] = (value >>> 8)
  buff[0] = (value & 0xff)
  return buff
}

let TOKENS = {
  REQUEST: 0,
  BLOCK: 1,
  END: 2
}
const RTOKENS = new Map(Object.entries([k, v] => [v, k]))
TOKENS = Object.fromEntries(Object.entries([k, v] => [k, enc8(v)]))

const handlers = {
  end: {
    encode: (id) => bl([ TOKENS.END, enc32(id) ])
  },
  block: {
    encode: ({ cid, bytes }) => {
      return [ TOKENS.BLOCK, enc8(cid.bytes.byteLength), cid.bytes, bytes ]
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
const wrap = (handler) => {
  return (conn, ...args) => {
    const b = handlers(...args)
    conn.write(enc32(b.length))
    conn.write(b.slice())
  }
}
const msg = {
  end: wrap(handlers.end),
  block: wrap(handlers.block)
}

const create = ({ onAsk, onBlock }) => {
  const parser = () => {}
  const parseAddress => str => {
    if (str.startsWith('tcp://')) str = str.slice('tcp://'.length)
    return str.split(':').filter(x => x).reverse()
  }
  const connections = {}
  const server = net.createServer(socket => {
    parser(socket)
  })
  const reqid = 0
  const reqs = new Map()
  const request = (addr, req) => {
    let conn
    if (connections[addr]) conn = connections[addr].deref()
    if (!conn) {
      conn = net.connect(...parseAddress(addr))
      parser(conn)
    }
    connections[addr] = new WeakRef(conn)
    const id = reqid++
    reqs.set(id, new Promise(resolve => {
      reqs.get(id).resolve = resolve
    }))
    msg.request(conn, req)
    return reqs.get(id)
  }
  const close = async () => {
    // TODO: check if open
    await server.close()
    // TODO: iterate over open connections
  }
  return { server, request, close }
}
