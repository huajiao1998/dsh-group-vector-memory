import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { apply } from '../lib/index.js'
import { createRpc } from '../lib/rpc.js'

function fixture(t, size) {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), 'gvm-rebuild-'))
  let dispose
  const runtime = apply({ connection: { rpc: { handle() {} } }, effect: init => { dispose = init() } }, { dataDir, imPath: join(dataDir, 'absent.sqlite') })
  t.after(() => {
    dispose()
    if (realpathSync(dataDir) === dataDir) rmSync(dataDir, { recursive: true })
  })
  const rpc = createRpc(runtime)
  const status = async () => (await rpc('embedding/rebuild/status')).value
  const start = target => rpc('embedding/rebuild/start', { confirm: true, target })
  const save = embedding => rpc('config/set', { embedding })
  const rows = Array.from({ length: size }, (_, i) => ({ id: `m${i}`, groupId: 'g', senderId: 'u', sentAt: i, text: `合成发言 ${i}` }))
  runtime.store.upsertMessages(rows)
  const vector = new Float32Array([1, 0])
  const embedded = { vector }
  runtime.embedder.embedOne = async () => embedded
  return { runtime, rows, rpc, save, start, status, vector, embedded }
}

async function until(fn) {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await setImmediate()
  }
  assert.fail('未观察到预期重建状态')
}

async function settled(status) {
  return until(async () => {
    const value = await status()
    return value.state !== 'running' && value
  })
}

test('手动重建后台分批运行，重复点击和定时同步不重复请求', async t => {
  const { runtime, rpc, start, status, vector, embedded, rows } = fixture(t, 205)
  runtime.store.setEmbedding('m0', vector, rows[0].text)
  const first = Promise.withResolvers()
  const requests = []
  runtime.embedder.embedOne = async (text) => {
    requests.push(text)
    if (requests.length === 1) return first.promise
    return embedded
  }
  const before = await status()
  assert.deepEqual([before.state, before.available, before.total, before.embedded], ['idle', true, 205, 1])
  assert.equal((await rpc('embedding/rebuild/start', { target: before.target })).ok, false)
  assert.equal(requests.length, 0)
  const reply = await start(before.target)
  assert.equal(reply.value.state, 'running')
  assert.equal(requests.length, 0, '启动 RPC 不等首个向量')
  await until(() => requests.length)
  assert.equal((await start(before.target)).value.state, 'running')
  assert.match((await runtime.syncOnce()).skipped, /后台重建/)
  first.resolve(embedded)
  const finished = await settled(status)
  assert.deepEqual([finished.state, finished.total, finished.embedded], ['done', 205, 205])
  assert.deepEqual(requests, rows.slice(1).map(row => row.text))
  assert.equal((await start(before.target)).value.state, 'done')
  assert.equal(requests.length, 204)
  assert.equal(runtime.store.messagesOf('u', 'g', 1)[0].text, rows.at(-1).text)
})

test('失败后保留进度，重试只补缺失的记录', async t => {
  const { runtime, start, status, embedded, rows } = fixture(t, 9)
  const requests = []
  let fail = true
  runtime.embedder.embedOne = async (text) => {
    requests.push(text)
    if (fail && text !== rows[0].text) throw new Error('提供方可能回显历史文本，不应进入重建状态')
    return embedded
  }
  const { target } = await status()
  assert.equal((await start(target)).ok, true)
  const stopped = await settled(status)
  assert.deepEqual([stopped.state, stopped.embedded, requests.length], ['paused', 1, 4])
  assert.doesNotMatch(stopped.error, /回显/)
  fail = false
  requests.length = 0
  assert.equal((await start(target)).ok, true)
  assert.equal((await settled(status)).state, 'done')
  assert.deepEqual(requests, rows.slice(1).map(row => row.text))
})

test('配置变更会拒绝旧确认、取消在途重建，且新模型只用自己的向量', async t => {
  const { runtime, save, start, status, embedded, rows } = fixture(t, 4)
  const previous = (await status()).target
  await save({ model: 'first-model' })
  assert.equal((await start(previous)).ok, false)
  const original = await status()
  const inFlight = Promise.withResolvers()
  const calls = []
  runtime.embedder.embedOne = (text, { config, signal }) => {
    calls.push({ text, model: config.embedding.model, signal })
    return inFlight.promise
  }
  assert.equal((await start(original.target)).ok, true)
  await until(() => calls[0])
  assert.equal((await save({ model: 'new-model' })).ok, true)
  const stopped = await status()
  assert.deepEqual([stopped.state, stopped.model, stopped.embedded], ['stopped', 'new-model', 0])
  assert.equal(calls[0].signal.aborted, true)
  assert.equal((await start(original.target)).ok, false)
  inFlight.resolve(embedded)
  await until(() => !runtime.rebuild.running)
  assert.equal((await status()).embedded, 0)
  assert.equal(calls.length, 1)
  runtime.embedder.embedOne = async (text, { config }) => {
    assert.equal(config.embedding.model, 'new-model')
    return embedded
  }
  assert.equal((await start(stopped.target)).ok, true)
  assert.equal((await settled(status)).embedded, rows.length)
  await save({ enabled: false })
  const disabled = await status()
  assert.equal(disabled.available, false)
  assert.equal((await start(disabled.target)).ok, false)
})

test('重建等待正在处理的同步批次结束，并从实际缺失处开始', async t => {
  const { runtime, start, status, rows, embedded } = fixture(t, 103)
  const first = Promise.withResolvers()
  const requests = []
  runtime.embedder.embedOne = async text => {
    requests.push(text)
    return requests.length === 1 ? first.promise : embedded
  }
  const syncing = runtime.syncOnce()
  assert.equal((await start((await status()).target)).value.state, 'running')
  await setImmediate()
  assert.equal(requests.length, 1)
  first.resolve(embedded)
  assert.equal((await syncing).embedded, 100)
  assert.equal((await settled(status)).embedded, 103)
  assert.deepEqual(requests, rows.map(row => row.text))
})
