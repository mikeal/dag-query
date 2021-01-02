/* globals describe, it */
import Node from '../index.js'
import { deepStrictEqual as same } from 'assert'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { encode, decode } from 'multiformats/block'

const inmem = () => {
  const store = {}
  const get = async cid => {
    const key = cid.toString()
    if (!store[key]) throw new Error('Not found. No such block')
    return store[key]
  }
  const put = async block => {
    store[block.cid.toString()] = block
  }
  return { get, put }
}

describe('blockswap', () => {
  it('basics', async () => {
    const store = inmem()
    const server = Node.create({ store })
    const client = Node.create({ store })
    const addrs = await server.serve()
    const protocol = await client.connect(addrs[0])
    const block = await encode({ value: Math.random(), codec, hasher })
    await store.put(block)
    const resp = await protocol.request('blockswap', { blockswap: { get: block.cid } })
    console.log({resp})
  })
})
