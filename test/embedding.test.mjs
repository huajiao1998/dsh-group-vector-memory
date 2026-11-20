import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedder, embeddingSpace } from '../lib/embed.js'
import { createRpc } from '../lib/rpc.js'
import { apply } from '../lib/index.js'

function success(embedding) {
  return { ok: true, json: async () => ({ data: [{ embedding }] }) }
}

test('向量请求按配置缓存，连接测试总是发新请求', async t => {
  let config = { embedding: { baseUrl: 'https://first.example/v1', model: 'fixture', dimensions: 2, apiKey: 'first' } }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.headers.authorization])
    return success([1, 0])
  })
  const embedder = createEmbedder({ get: () => config })
  await Promise.all([embedder.embedOne('合成输入'), embedder.embedOne('合成输入')])
  assert.equal(requests.length, 1)
  await embedder.test()
  await embedder.test()
  assert.equal(requests.length, 3)
  config = { embedding: { ...config.embedding, baseUrl: 'https://second.example/v1/embeddings', apiKey: 'second' } }
  await embedder.embedOne('合成输入')
  assert.deepEqual(requests.at(-1), ['https://second.example/v1/embeddings', 'Bearer second'])
  config = { embedding: { ...config.embedding, dimensions: 3 } }
  await assert.rejects(embedder.embedOne('合成输入'), /维度不一致/)
  assert.equal(requests.length, 5)
})

test('切换服务不把旧密钥带过去，且不接收在途中生成的旧空间向量', async t => {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'gvm-embedding-test-'))
  let dispose
  const runtime = apply({ connection: { rpc: { handle() {} } }, effect: init => { dispose = init() } }, { dataDir, imPath: join(dataDir, 'absent.sqlite') })
  t.after(() => {
    dispose()
    if (realpathSync(dataDir) === dataDir) rmSync(dataDir, { recursive: true })
  })
  const rpc = createRpc(runtime)
  const save = embedding => rpc('config/set', { embedding })
  assert.equal((await save({ baseUrl: 'https://first.example/v1', model: 'fixture', dimensions: 2, apiKey: 'old' })).ok, true)
  runtime.store.upsertMessages([{ id: 'x', senderId: 'u', groupId: 'g', text: '旧内容', sentAt: 1 }])
  const result = Promise.withResolvers()
  runtime.embedder.embedOne = () => result.promise
  const syncing = runtime.syncOnce()
  assert.equal((await save({ baseUrl: 'https://second.example/v1' })).ok, false)
  assert.equal((await save({ baseUrl: 'https://second.example/v1', apiKey: '' })).ok, true)
  result.resolve({ vector: new Float32Array([1, 0]) })
  assert.equal((await syncing).embedded, 0)
  assert.equal(runtime.store.stats().embedded, 0)
  runtime.embedder.embedOne = async (_text, { config }) => {
    assert.equal(embeddingSpace(config), embeddingSpace(runtime.configStore.get()))
    return { vector: new Float32Array([0, 1]) }
  }
  assert.equal((await runtime.syncOnce()).embedded, 1)
  assert.deepEqual([...runtime.store.vectorsBySender('u', 1, 'g')[0].vector], [0, 1])
})
