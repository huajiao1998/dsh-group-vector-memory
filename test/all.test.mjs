import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore, DEFAULT_CONFIG } from '../lib/config.js'
import { createStore, cosine } from '../lib/store.js'
import { createImReader, defaultImPath } from '../lib/dshim.js'
import { recallSync, recallAsync, formatMemoryBlock, extractKeywords } from '../lib/recall.js'
import { parseImSource, mountAgent, cleanQuery, findGroupMessage, workspaceAllowed } from '../lib/inject.js'
import { createRpc } from '../lib/rpc.js'
import { registerMemoryTool } from '../lib/tool.js'
import { createEmbedder } from '../lib/embed.js'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'gvm-'))
const clean = (d) => { try { rmSync(d, { recursive: true, force: true }) } catch {} }

// ---------------- config ----------------
test('config: 默认值完整', () => {
  const d = tmp()
  const cs = createConfigStore(d)
  const c = cs.get()
  assert.equal(c.embedding.model, 'BAAI/bge-m3')
  assert.equal(c.recall.recent, 10)
  assert.equal(c.recall.semantic, 8)
  assert.equal(c.inject.enabled, true)
  clean(d)
})

test('config: publicView 不泄漏明文 apiKey', () => {
  const d = tmp()
  const cs = createConfigStore(d)
  cs.update({ embedding: { apiKey: 'sk-super-secret' } })
  const view = cs.publicView()
  assert.equal(view.embedding.apiKey, undefined)
  assert.equal(view.embedding.apiKeySet, true)
  assert.ok(!JSON.stringify(view).includes('sk-super-secret'))
  clean(d)
})

test('config: 部分更新不清空其他字段', () => {
  const d = tmp()
  const cs = createConfigStore(d)
  cs.update({ recall: { recent: 3 } })
  const c = cs.get()
  assert.equal(c.recall.recent, 3)
  assert.equal(c.recall.semantic, 8, 'semantic 应保留默认')
  assert.equal(c.embedding.model, 'BAAI/bge-m3')
  clean(d)
})

// ---------------- store ----------------
test('store: upsert 幂等，重复写不增加行数', () => {
  const d = tmp()
  const s = createStore(d)
  const row = { id: 'g:1', groupId: 'g', senderId: 'u1', senderName: '张三', text: 'hi', sentAt: 1 }
  s.upsertMessages([row])
  s.upsertMessages([row])
  assert.equal(s.stats().messages, 1)
  s.close(); clean(d)
})

test('store: 向量写入读回一致', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: 'x', sentAt: 1 }])
  s.setEmbedding('g:1', new Float32Array([0.1, 0.2, 0.3]))
  const v = s.vectorsBySender('u1')
  assert.deepEqual(Array.from(v[0].vector).map(x => +x.toFixed(4)), [0.1, 0.2, 0.3])
  s.close(); clean(d)
})

test('store: meta 持久化', () => {
  const d = tmp()
  const s1 = createStore(d)
  s1.setMeta('last_sent_at', 12345)
  s1.close()
  const s2 = createStore(d)
  assert.equal(Number(s2.getMeta('last_sent_at', 0)), 12345)
  s2.close(); clean(d)
})

test('store: cosine 边界（零向量、同向量）', () => {
  assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 0])), 0)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])) + 1) < 1e-6)
})

test('store: pendingEmbeddings 只返回没向量的', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', text: 'a', sentAt: 1 },
    { id: 'g:2', groupId: 'g', senderId: 'u1', text: 'b', sentAt: 2 },
  ])
  s.setEmbedding('g:1', new Float32Array([1]))
  const pending = s.pendingEmbeddings(10)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'g:2')
  s.close(); clean(d)
})

// ---------------- sync ----------------
function makeSyncRuntime(t, rows = []) {
  const d = tmp()
  const imPath = join(d, 'im.sqlite')
  const db = new DatabaseSync(imPath)
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, platform_message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL
  )`)
  const insert = db.prepare("INSERT INTO messages VALUES (?, 'g', ?, 'u1', '', ?, ?)")
  for (const row of rows) insert.run(...row)
  db.close()
  let dispose
  const runtime = apply({ connection: { rpc: { handle() {} } }, effect: init => { dispose = init() } }, { dataDir: d, imPath })
  t.after(() => { dispose(); clean(d) })
  return runtime
}

test('sync: watcher 不跳过待入库消息，同一时间戳可跨批次续读', async t => {
  const rows = Array.from({ length: 502 }, (_, i) => [`m${String(i).padStart(3, '0')}`, '', '原始文本', 10])
  const runtime = makeSyncRuntime(t, rows)
  runtime.embedder.embedOne = async () => ({ vector: new Float32Array([1]), dims: 1 })
  await runtime.watchNew()
  assert.equal(runtime.store.stats().messages, 0)
  assert.equal(runtime.store.getSyncCursor(), 0)
  assert.equal((await runtime.syncOnce()).added, 500)
  assert.equal((await runtime.syncOnce()).added, 2)
  assert.equal((await runtime.syncOnce()).added, 0)
  assert.equal(runtime.store.stats().messages, 502)
  const last = runtime.imReader.since({ sentAt: 10, sourceId: 'm500' }, 1)[0]
  assert.equal(last.id, runtime.imReader.since(0, 502).at(-1).id, '缺少平台 ID 时也要跨批次保持稳定 ID')
  assert.equal(runtime.store.deleteMessage(last.id, 'g', 'u1'), true)
  assert.equal(runtime.store.upsertMessages([last]), 0)
  assert.equal(runtime.store.stats().messages, 501)
})

test('sync: 编辑后的记忆不接收旧向量，无新消息照常重算', async t => {
  const runtime = makeSyncRuntime(t, [['row1', '1', '原始文本', 10]])
  const oldVector = Promise.withResolvers()
  runtime.embedder.embedOne = () => oldVector.promise
  const inFlight = runtime.syncOnce()
  const rpc = createRpc(runtime)
  const edited = await rpc('members/message-update', { messageId: 'g:1', groupId: 'g', senderId: 'u1', text: '修改后的文本' })
  assert.equal(edited.ok, true)
  oldVector.resolve({ vector: new Float32Array([0]) })
  assert.equal((await inFlight).embedded, 0)
  assert.equal(runtime.store.stats().embedded, 0)
  runtime.embedder.embedOne = async text => {
    assert.equal(text, '修改后的文本')
    return { vector: new Float32Array([1]) }
  }
  const result = await runtime.syncOnce()
  assert.equal(result.added, 0)
  assert.equal(result.embedded, 1, result.embedError)
  assert.deepEqual([...runtime.store.vectorsBySender('u1')[0].vector], [1])
})

// ---------------- recall ----------------
test('recallSync: 同 sender 最近 N 条，倒序取最新', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([1,2,3].map(i => ({ id: `g:${i}`, groupId: 'g', senderId: 'u1', text: `m${i}`, sentAt: i })))
  const r = recallSync({ store: s, senderId: 'u1', query: '', cfg: { recall: { recent: 2, semantic: 0, minScore: 0 } } })
  assert.deepEqual(r.recent.map(x => x.text), ['m3', 'm2'])
  s.close(); clean(d)
})

test('recallSync: 其他 sender 的消息不混入', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', text: 'u1说的', sentAt: 1 },
    { id: 'g:2', groupId: 'g', senderId: 'u2', text: 'u2说的', sentAt: 2 },
  ])
  const r = recallSync({ store: s, senderId: 'u1', query: '', cfg: { recall: { recent: 10, semantic: 0, minScore: 0 } } })
  assert.equal(r.recent.length, 1)
  assert.equal(r.recent[0].text, 'u1说的')
  s.close(); clean(d)
})

test('recallSync: 语义召回用已入库向量，排除已在 recent 里的', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', text: '旧话题A', sentAt: 1 },
    { id: 'g:2', groupId: 'g', senderId: 'u1', text: '旧话题B', sentAt: 2 },
    { id: 'g:3', groupId: 'g', senderId: 'u1', text: '当前这句', sentAt: 3 },
  ])
  s.setEmbedding('g:1', new Float32Array([1, 0, 0]))
  s.setEmbedding('g:2', new Float32Array([0, 1, 0]))
  s.setEmbedding('g:3', new Float32Array([1, 0.01, 0]))
  const r = recallSync({ store: s, senderId: 'u1', query: '当前这句', cfg: { recall: { recent: 1, semantic: 5, minScore: 0.1 } } })
  assert.equal(r.recent.length, 1)
  assert.equal(r.recent[0].text, '当前这句')
  assert.equal(r.semantic[0].text, '旧话题A', '和当前句最像的应排第一')
  assert.ok(!r.semantic.some(x => x.text === '当前这句'), '不应重复召回当前句')
  s.close(); clean(d)
})

test('recallSync: 空 store 不崩', () => {
  const d = tmp()
  const s = createStore(d)
  const r = recallSync({ store: s, senderId: 'nobody', query: 'x', cfg: {} })
  assert.deepEqual(r, { recent: [], semantic: [], literal: [] })
  s.close(); clean(d)
})

test('recallAsync: embedding 失败时退回同步结果', async () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: 'x', sentAt: 1 }])
  const r = await recallAsync({ store: s, embedder: { embedOne: async () => { throw new Error('网络错') } }, senderId: 'u1', query: 'x', cfg: { recall: { recent: 5, semantic: 5, minScore: 0 } } })
  assert.equal(r.recent.length, 1)
  assert.deepEqual(r.semantic, [])
  s.close(); clean(d)
})

test('formatMemoryBlock: 超长截断', () => {
  const block = formatMemoryBlock({ senderName: 'A', userId: 'u', recent: [{ text: 'x'.repeat(500) }], semantic: [], maxChars: 100 })
  assert.ok(block.length <= 101)
})

test('formatMemoryBlock: 无名字时用 ID', () => {
  const block = formatMemoryBlock({ senderName: '', userId: 'u42', recent: [], semantic: [] })
  assert.match(block, /u42/)
})

// ---------------- inject（agent/pre-step waterfall） ----------------
const mkMsg = (meta, body = '说话内容') => ({
  role: 'user',
  source: { kind: 'user', rpcId: 'qq-00000000-0000-4000-8000-000000000001' },
  content: [{ type: 'text', text: `<dsh_im_source>${JSON.stringify(meta)}</dsh_im_source>\n${body}` }],
})

test('inject: 解析群消息', () => {
  const m = parseImSource(mkMsg({ channel: 'qq', senderId: 'u1', senderName: '王阿牛', chatId: 'g1' }).content[0].text)
  assert.equal(m.senderId, 'u1')
})

test('inject: 无 source 返回 null', () => {
  assert.equal(parseImSource('普通文字'), null)
})

test('inject: 坏 JSON 返回 null 不崩', () => {
  assert.equal(parseImSource('<dsh_im_source>{bad}</dsh_im_source>\nhi'), null)
})

test('inject: cleanQuery 与缓存 key 对齐', () => {
  assert.equal(cleanQuery('<dsh_im_source>{"a":1}</dsh_im_source>\n<@ABC> 你好啊'), '@某人 你好啊')
})

test('inject: 从这一轮消息里找群消息', () => {
  const msgs = [
    mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' }),
    { role: 'user', content: [{ type: 'text', text: '普通消息' }] },
    mkMsg({ channel: 'qq', senderId: 'uB', senderName: '乙', chatId: 'g1' }),
  ]
  const hit = findGroupMessage(msgs)
  assert.equal(hit.meta.senderId, 'uB', '取最后一条群消息')
})

function makeAgent() {
  const handlers = []
  const agent = {
    session: { id: 's1' },
    ctx: { on: (n, f) => { handlers.push({ n, f }); return () => {} } },
  }
  return { agent, handlers }
}

function makeRuntime() {
  return {
    log: () => {},
    configStore: { get: () => ({ enabled: true, inject: { enabled: true, maxChars: 2000 }, recall: { recent: 10, semantic: 8, minScore: 0 } }) },
    ctx: { tools: { get: () => ({ name: 'dsh_im_group_history', execute: async () => ({ groupName: 'fixture-a', items: [] }) }) } },
    imReader: { path: defaultImPath(), groups: () => [{ id: 'group-a', channel: 'qq', platform_group_id: 'g1', name: 'fixture-a' }] },
    embedOne: async () => ({ vector: new Float32Array([1, 0]), dims: 2 }),
    recall: (senderId) => ({
      recent: [{ text: '最近一条' }],
      semantic: [{ text: '语义捞到的' }],
      literal: [{ text: '字面捞到的' }],
    }),
    format: ({ senderName, recent, semantic, literal }) =>
      `【群里这个人：${senderName}】recent=${recent.length} semantic=${semantic.length} literal=${(literal || []).length}`,
  }
}

async function firePreStep(handlers, messages, nextImpl) {
  const h = handlers.find(x => x.n === 'agent/pre-step')
  if (!h) throw new Error('没挂 agent/pre-step')
  const next = nextImpl || (async () => ({ kind: 'enter', messages }))
  return h.f({ messages, turn: 1, step: 1 }, next)
}

test('inject: 挂的是 agent/pre-step 钩子', () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  assert.ok(handlers.some(x => x.n === 'agent/pre-step'), '应监听 agent/pre-step')
})

test('inject: 群消息这一轮会被追加记忆块（模型必然看到）', async () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  const msgs = [mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' })]
  const decision = await firePreStep(handlers, msgs)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, '原消息 + 记忆块')
  const memoryText = decision.messages[1].content[0].text
  assert.match(memoryText, /甲/)
  assert.match(memoryText, /semantic=1/, '语义召回要带上（pre-step 里等过向量化）')
  assert.match(memoryText, /literal=1/)
})

test('inject: 记忆块带来源标记', async () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  const decision = await firePreStep(handlers, [mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' })])
  assert.equal(decision.messages[1].source.kind, 'group-vector-memory')
})

test('inject: 私聊消息不注入', async () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  const msgs = [mkMsg({ channel: 'qq', senderId: 'uA' })]
  const decision = await firePreStep(handlers, msgs)
  assert.equal(decision.messages.length, 1)
})

test('inject: 没有群消息时放行原 messages', async () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '普通' }] }]
  const decision = await firePreStep(handlers, msgs)
  assert.equal(decision.messages.length, 1)
})

test('inject: inject.enabled=false 时不注入', async () => {
  const runtime = makeRuntime()
  runtime.configStore.get = () => ({ inject: { enabled: false }, recall: { recent: 10, semantic: 8 } })
  const { agent, handlers } = makeAgent()
  mountAgent(agent, runtime)
  const decision = await firePreStep(handlers, [mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' })])
  assert.equal(decision.messages.length, 1)
})

test('inject: 召回失败也要放行（不能卡住这一轮）', async () => {
  const runtime = makeRuntime()
  runtime.embedOne = async () => { throw new Error('网络炸了') }
  const { agent, handlers } = makeAgent()
  mountAgent(agent, runtime)
  const decision = await firePreStep(handlers, [mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' })])
  assert.equal(decision.kind, 'enter', '失败也要 enter，不能 reject')
})

test('inject: 默认行为返回 reject 时原样透传', async () => {
  const { agent, handlers } = makeAgent()
  mountAgent(agent, makeRuntime())
  const decision = await firePreStep(handlers, [mkMsg({ channel: 'qq', senderId: 'uA', senderName: '甲', chatId: 'g1' })],
    async () => ({ kind: 'reject', reason: 'x' }))
  assert.equal(decision.kind, 'reject')
})

// ---------------- rpc ----------------
function makeRpcRuntime() {
  const d = tmp()
  const configStore = createConfigStore(d)
  const store = createStore(d)
  const embedder = createEmbedder(configStore)
  const imReader = createImReader('/nonexistent.sqlite')
  const runtime = { configStore, store, embedder, imReader, dataDir: d, syncOnce: async () => ({ added: 1, embedded: 1 }) }
  return { rpc: createRpc(runtime), store, d }
}

test('rpc: config/get 返回脱敏配置', async () => {
  const { rpc, d } = makeRpcRuntime()
  const r = await rpc('config/get', {})
  assert.equal(r.ok, true)
  assert.equal(r.value.config.embedding.apiKey, undefined)
  clean(d)
})

test('rpc: config/set 保存并脱敏返回', async () => {
  const { rpc, d } = makeRpcRuntime()
  const r = await rpc('config/set', { embedding: { model: 'BAAI/bge-small-zh-v1.5' } })
  assert.equal(r.ok, true)
  assert.equal(r.value.config.embedding.model, 'BAAI/bge-small-zh-v1.5')
  clean(d)
})

test('rpc: 未知端点返回错误', async () => {
  const { rpc, d } = makeRpcRuntime()
  const r = await rpc('nope', {})
  assert.equal(r.ok, false)
  clean(d)
})

test('rpc: preview 缺 senderId 返回错误', async () => {
  const { rpc, d } = makeRpcRuntime()
  const r = await rpc('preview', {})
  assert.equal(r.ok, false)
  clean(d)
})

test('rpc: stats 在 IM 库不存在时不崩', async () => {
  const { rpc, d } = makeRpcRuntime()
  const r = await rpc('stats', {})
  assert.equal(r.ok, true)
  assert.equal(r.value.im.available, false)
  clean(d)
})

test('rpc: sync 失败捕获成 ok:false', async () => {
  const { rpc, d } = makeRpcRuntime()
  clean(d)
  const r = await rpc('sync', {})
  assert.equal(typeof r.ok, 'boolean')
})

// ---------------- embed ----------------
test('embed: 未配置 baseUrl 时抛清晰错误', async () => {
  const d = tmp()
  const cs = createConfigStore(d)
  cs.update({ embedding: { baseUrl: '', model: '' } })
  const e = createEmbedder(cs)
  await assert.rejects(() => e.test(), /未配置|缺少/)
  clean(d)
})

test('embed: 接口返回异常时抛错且不污染缓存', async () => {
  const d = tmp()
  const cs = createConfigStore(d)
  cs.update({ embedding: { baseUrl: 'http://127.0.0.1:9', model: 'x', timeoutMs: 200 } })
  const e = createEmbedder(cs)
  await assert.rejects(() => e.embedOne('hi'))
  clean(d)
})

console.log('\n所有测试跑完')

// ---------------- 二轮排查新增 ----------------
test('store: 未对齐的 blob 也能读回向量（SQLite Buffer 对齐）', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: 'x', sentAt: 1 }])
  s.setEmbedding('g:1', new Float32Array([0.5, 0.25, 0.125]))
  const v = s.vectorsBySender('u1')[0].vector
  assert.equal(v.length, 3)
  assert.ok(Math.abs(v[0] - 0.5) < 1e-6)
  s.close(); clean(d)
})

test('store: cosine 维度不一致返回 0（不静默算部分维度）', () => {
  assert.equal(cosine(new Float32Array([1, 0, 0]), new Float32Array([1, 0])), 0)
})

test('store: 文本变更时旧向量失效', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: '旧', sentAt: 1 }])
  s.setEmbedding('g:1', new Float32Array([1, 0]))
  s.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: '新', sentAt: 1 }])
  assert.equal(s.pendingEmbeddings(10).length, 1, '改了文本应重新向量化')
  s.close(); clean(d)
})

test('config: 配置文件里 embedding 缺失时 publicView 不崩', () => {
  const d = tmp()
  writeFileSync(join(d, 'config.json'), JSON.stringify({ enabled: true, embedding: null }))
  const cs = createConfigStore(d)
  const v = cs.publicView()
  assert.ok(v.embedding)
  assert.equal(v.embedding.apiKey, undefined)
  clean(d)
})

test('config: apiKey 为空时 apiKeySet=false', () => {
  const d = tmp()
  const cs = createConfigStore(d)
  const v = cs.publicView()
  assert.equal(v.embedding.apiKeySet, false)
  clean(d)
})

test('embed: 维度不一致时报清晰错误', async () => {
  const d = tmp()
  const cs = createConfigStore(d)
  cs.update({ embedding: { baseUrl: 'http://127.0.0.1:9', model: 'x', dimensions: 1024, timeoutMs: 200 } })
  const e = createEmbedder(cs)
  await assert.rejects(() => e.embedOne('hi'))
  clean(d)
})

test('rpc: 预览只查指定群，不把默认原文发给向量服务', async () => {
  const d = tmp()
  const configStore = createConfigStore(d)
  const store = createStore(d)
  store.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', senderName: 'A', text: '本群最后一句', sentAt: 1 },
    { id: 'x:1', groupId: 'x', senderId: 'u1', senderName: 'A', text: '其他群内容', sentAt: 2 },
  ])
  const runtime = {
    configStore, store, dataDir: d,
    embedder: { embedOne: async () => null },
    imReader: createImReader('/nonexistent.sqlite'),
    syncOnce: async () => ({}),
  }
  const rpc = createRpc(runtime)
  const r = await rpc('preview', { senderId: 'u1', groupId: 'g' })
  assert.equal(r.ok, true, r.error?.message)
  assert.match(r.value.block, /本群最后一句/)
  assert.doesNotMatch(r.value.block, /其他群内容/)
  store.close(); clean(d)
})

test('members: 按群列出成员', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', senderName: '甲', text: 'a', sentAt: 1 },
    { id: 'g:2', groupId: 'g', senderId: 'u1', senderName: '甲', text: 'b', sentAt: 2 },
    { id: 'g:3', groupId: 'g', senderId: 'u2', senderName: '乙', text: 'c', sentAt: 3 },
  ])
  s.setEmbedding('g:1', new Float32Array([1, 0]))
  const list = s.members()
  assert.equal(list.length, 2)
  assert.equal(s.members('g').length, 2)
  assert.equal(s.members('other-group').length, 0, '别的群应为空')
  const jia = list.find(x => x.senderId === 'u1')
  assert.equal(jia.count, 2)
  assert.ok(jia.vecBytes > 0)
  s.close(); clean(d)
})

test('members: 能看某人的消息', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([1,2,3].map(i => ({ id: `g:${i}`, groupId: 'g', senderId: 'u1', text: `m${i}`, sentAt: i })))
  const msgs = s.messagesOf('u1', undefined, 2)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].text, 'm3', '最新在前')
  s.close(); clean(d)
})

test('members: 删除只删指定群里指定的人，不影响别的群', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g1:1', groupId: 'g1', senderId: 'u1', text: 'a', sentAt: 1 },
    { id: 'g1:2', groupId: 'g1', senderId: 'u2', text: 'b', sentAt: 2 },
    { id: 'g2:1', groupId: 'g2', senderId: 'u1', text: 'c', sentAt: 3 },
  ])
  const n = s.deleteSender('u1', 'g1')
  assert.equal(n, 1, '只删 g1 里 u1 的那条')
  assert.equal(s.stats().messages, 2)
  assert.equal(s.members('g2').length, 1, 'g2 里的 u1 还在')
  assert.equal(s.members('g2')[0].count, 1)
  s.upsertMessages([
    { id: 'g1:1', groupId: 'g1', senderId: 'u1', text: 'a', sentAt: 1 },
    { id: 'g1:2', groupId: 'g1', senderId: 'u2', text: 'b', sentAt: 2 },
  ])
  assert.equal(s.stats().messages, 2, '整位群友清除后同步不可复活被删的消息')
  s.close(); clean(d)
})

test('members: 单条编辑会让旧向量失效，并覆盖后续 IM 同步', () => {
  const d = tmp()
  const s = createStore(d)
  const row = { id: 'g:1', groupId: 'g', senderId: 'u1', senderName: '甲', text: '原始记忆', sentAt: 1 }
  s.upsertMessages([row])
  s.setEmbedding(row.id, new Float32Array([1, 0]))
  assert.equal(s.updateMessage(row.id, row.groupId, row.senderId, '手工改过的记忆'), true)
  assert.deepEqual(s.messagesOf('u1', 'g')[0], { id: 'g:1', text: '手工改过的记忆', sentAt: 1, groupId: 'g' })
  assert.equal(s.stats().embedded, 0, '编辑后旧向量必须失效')
  s.upsertMessages([row])
  assert.equal(s.messagesOf('u1', 'g')[0].text, '手工改过的记忆', '同步不能覆盖手工编辑')
  assert.equal(s.updateMessage(row.id, 'other', row.senderId, '不应改成功'), false, '群不匹配时拒绝')
  assert.equal(s.updateMessage(row.id, row.groupId, row.senderId, '   '), false, '空内容拒绝')
  s.close(); clean(d)
})

test('members: 单条删除写 tombstone，后续 IM 同步不会复活', () => {
  const d = tmp()
  const s = createStore(d)
  const row = { id: 'g:1', groupId: 'g', senderId: 'u1', text: '要删掉', sentAt: 1 }
  s.upsertMessages([row])
  assert.equal(s.deleteMessage(row.id, row.groupId, row.senderId), true)
  assert.equal(s.stats().messages, 0)
  s.upsertMessages([row])
  assert.equal(s.stats().messages, 0, '删除标记必须拦住后续同步')
  assert.equal(s.deleteMessage(row.id, row.groupId, row.senderId), false, '已删除的消息不能重复删除')
  s.close(); clean(d)
})

test('members: groups() 按群统计', () => {
  const d = tmp()
  const s = createStore(d)
  s.upsertMessages([
    { id: 'g1:1', groupId: 'g1', senderId: 'u1', text: 'a', sentAt: 1 },
    { id: 'g2:1', groupId: 'g2', senderId: 'u2', text: 'b', sentAt: 2 },
    { id: 'g2:2', groupId: 'g2', senderId: 'u2', text: 'c', sentAt: 3 },
  ])
  const gs = s.groups()
  assert.equal(gs.length, 2)
  const g2 = gs.find(x => x.groupId === 'g2')
  assert.equal(g2.count, 2)
  assert.equal(g2.people, 1)
  s.close(); clean(d)
})

test('rpc: members/delete 必须同时有 groupId 和 confirm', async () => {
  const d = tmp()
  const store = createStore(d)
  store.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: 'a', sentAt: 1 }])
  const runtime = { store, configStore: createConfigStore(d), dataDir: d, embedder: {}, imReader: { available: () => false, latestArrival: floor => floor }, syncOnce: async () => ({}) }
  const rpc = createRpc(runtime)
  assert.equal((await rpc('members/delete', { senderId: 'u1', confirm: true })).ok, false, '没 groupId 应拒绝')
  assert.equal((await rpc('members/delete', { senderId: 'u1', groupId: 'g' })).ok, false, '没 confirm 应拒绝')
  assert.equal((await rpc('members/delete', { senderId: 'u1', groupId: 'g', confirm: true })).ok, false, '无法确定源端截止时不做部分清除')
  assert.equal(store.stats().messages, 1)
  runtime.imReader.available = () => true
  const yes = await rpc('members/delete', { senderId: 'u1', groupId: 'g', confirm: true })
  assert.equal(yes.ok, true)
  assert.equal(yes.value.deleted, 1)
  store.close(); clean(d)
})

test('rpc: 单条记忆编辑和删除必须校验群、成员和确认', async () => {
  const d = tmp()
  const store = createStore(d)
  store.upsertMessages([{ id: 'g:1', groupId: 'g', senderId: 'u1', text: 'a', sentAt: 1 }])
  const runtime = { store, configStore: createConfigStore(d), dataDir: d, embedder: {}, imReader: createImReader('/nope'), syncOnce: async () => ({}) }
  const rpc = createRpc(runtime)
  assert.equal((await rpc('members/message-update', { messageId: 'g:1', senderId: 'u1', text: 'b' })).ok, false, '编辑缺 groupId 应拒绝')
  assert.equal((await rpc('members/message-update', { messageId: 'g:1', groupId: 'g', senderId: 'u1', text: 'b' })).ok, true)
  assert.equal(store.messagesOf('u1', 'g')[0].text, 'b')
  assert.equal((await rpc('members/message-delete', { messageId: 'g:1', groupId: 'g', senderId: 'u1' })).ok, false, '删除缺确认应拒绝')
  assert.equal((await rpc('members/message-delete', { messageId: 'g:1', groupId: 'g', senderId: 'u1', confirm: true })).ok, true)
  assert.equal((await rpc('members/message-delete', { messageId: 'g:1', groupId: 'g', senderId: 'u1', confirm: true })).ok, false, '重复删除应拒绝')
  store.close(); clean(d)
})

test('recall: 关键词字面召回（不依赖向量）', () => {
  const d = tmp()
  const store = createStore(d)
  store.upsertMessages([
    { id: 'g:1', groupId: 'g', senderId: 'u1', text: '群名怎么没有显示', sentAt: 1 },
    { id: 'g:2', groupId: 'g', senderId: 'u1', text: '今天天气不错', sentAt: 2 },
  ])
  const cfg = createConfigStore(d).get()
  const r = recallSync({ store, senderId: 'u1', query: '现在群名还是没有显示啊', cfg })
  assert.ok(r.literal.length >= 1, '应字面命中「群名」那条')
  assert.match(r.literal[0].text, /群名/)
  store.close(); clean(d)
})

test('extractKeywords: 中文按 3-4 字切片', () => {
  const kws = extractKeywords('现在群名还是没有显示啊')
  assert.ok(kws.some(k => k.includes('群名')), '应包含「群名」相关片段')
  assert.ok(kws.every(k => k.length >= 2), '不应有单字')
})

// ---------------- 查询工具 group_memory_lookup ----------------
function makeToolCtx() {
  const captured = {}
  const ctx = { tools: { register: (def) => { captured.def = def; return () => {} } } }
  return { ctx, captured }
}

function makeToolRuntime(overrides = {}) {
  const store = {
    members: () => [
      { senderId: 'uA', senderName: '王阿牛', count: 3 },
      { senderId: 'uB', senderName: '织衣', count: 2 },
    ],
    groups: () => [{ groupId: 'g1', label: 'QQ群 · g1' }],
    groupInfo: () => [{ groupId: 'g1', channel: 'qq', platformGroupId: 'OPENID1', qqNumber: '1050089697', name: 'AI生命' }],
    messagesOf: () => [
      { id: 'm1', text: '最近的一条', sentAt: 1795000000000, groupId: 'g1' },
    ],
    searchByKeywords: () => [
      { id: 'm2', text: '关键词命中的一条', sentAt: 1794900000000, groupId: 'g1' },
    ],
    vectorsBySender: () => [],
    ...overrides.store,
  }
  return {
    store,
    configStore: { get: () => ({ enabled: true, recall: { minScore: 0.25 } }) },
    embedder: { embedOne: async () => ({ vector: new Float32Array([1, 0]) }) },
    log: () => {},
    ...overrides,
  }
}

test('tool: 注册了 group_memory_lookup', () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  assert.equal(captured.def.name, 'group_memory_lookup')
  assert.ok(captured.def.parameters.properties.person, '必须有 person 参数')
  assert.deepEqual(captured.def.parameters.required, ['person'])
})

test('tool: 按名字查到人，返回最近记录', async () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = await captured.def.execute({ person: '王阿牛' })
  assert.equal(out.found, 1)
  assert.match(out.text, /王阿牛/)
  assert.match(out.text, /最近的一条/)
})

test('tool: 名字只写一部分也能找到', async () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = await captured.def.execute({ person: '阿牛' })
  assert.equal(out.found, 1)
})

test('tool: 查不到人时列出现有成员', async () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = await captured.def.execute({ person: '不存在的人' })
  assert.equal(out.found, 0)
  assert.match(out.text, /王阿牛/)
})

test('tool: 给 query 时走关键词召回', async () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = await captured.def.execute({ person: '王阿牛', query: '关键词' })
  assert.equal(out.found, 1)
  assert.match(out.text, /关键词命中的一条/)
})

test('tool: 插件关着时直说关了', async () => {
  const { ctx, captured } = makeToolCtx()
  const rt = makeToolRuntime()
  rt.configStore.get = () => ({ enabled: false })
  registerMemoryTool(ctx, rt, { trusted: true })
  const out = await captured.def.execute({ person: '王阿牛' })
  assert.equal(out.found, 0)
  assert.match(out.text, /未启用/)
})

test('tool: limit 上限 30 且默认 8', async () => {
  const { ctx, captured } = makeToolCtx()
  const calls = []
  const rt = makeToolRuntime({
    store: {
      members: () => [{ senderId: 'uA', senderName: '王阿牛', count: 3 }],
      groups: () => [],
      groupInfo: () => [],
      messagesOf: (sid, gid, lim) => { calls.push(lim); return [] },
      searchByKeywords: () => [],
      vectorsBySender: () => [],
    },
  })
  registerMemoryTool(ctx, rt, { trusted: true })
  await captured.def.execute({ person: '王阿牛' })
  assert.equal(calls[0], 8, '默认 8 条')
})

// ---------------- 按工作区启用 ----------------
test('workspace: 空配置全启用', () => {
  assert.equal(workspaceAllowed('/root/工作目录/AIlife', []), true)
  assert.equal(workspaceAllowed('/root/工作目录/AIlife', undefined), true)
  assert.equal(workspaceAllowed('/', []), true)
})

test('workspace: 精确匹配和子目录都算命中', () => {
  assert.equal(workspaceAllowed('/root/工作目录/AIlife', ['/root/工作目录/AIlife']), true)
  assert.equal(workspaceAllowed('/root/工作目录/AIlife/docs', ['/root/工作目录/AIlife']), true)
  assert.equal(workspaceAllowed('/root/工作目录/AIlife', ['/root/工作目录/AIlife/']), true)
})

test('workspace: 别的工作区不命中', () => {
  assert.equal(workspaceAllowed('/root/工作目录/pyssh', ['/root/工作目录/AIlife']), false)
  assert.equal(workspaceAllowed('/root/工作目录/AIlife2', ['/root/工作目录/AIlife']), false, '前缀要按目录边界，不能 AIlife2 也算')
  assert.equal(workspaceAllowed('', ['/root/工作目录/AIlife']), false, '没有 cwd 时保守拒绝')
})

test('workspace: 不匹配的会话只保留门控钩子，不注册工具', () => {
  const handlers = []
  const tools = []
  const agent = {
    session: { id: 's1', header: { cwd: '/root/工作目录/pyssh' } },
    ctx: {
      on: (n, f) => { handlers.push({ n, f }); return () => {} },
      tools: { register: (d) => { tools.push(d); return () => {} } },
    },
  }
  const runtime = makeRuntime()
  runtime.configStore.get = () => ({ enabled: true, inject: { enabled: true }, workspaces: ['/root/工作目录/AIlife'] })
  mountAgent(agent, runtime)
  assert.equal(handlers.length, 1, '保留钩子以响应运行中的配置变更')
  assert.equal(tools.length, 0, '没注册工具')
})

test('workspace: 匹配的会话挂 pre-step 并注册工具（agent scope）', () => {
  const handlers = []
  const tools = []
  const agent = {
    session: { id: 's1', header: { cwd: '/root/工作目录/AIlife' } },
    ctx: {
      on: (n, f) => { handlers.push({ n, f }); return () => {} },
      tools: { register: (d) => { tools.push(d); return () => {} } },
    },
  }
  const runtime = makeRuntime()
  runtime.configStore.get = () => ({ enabled: true, inject: { enabled: true }, workspaces: ['/root/工作目录/AIlife'] })
  mountAgent(agent, runtime)
  assert.ok(handlers.some(h => h.n === 'agent/pre-step'), '要挂 pre-step')
  assert.equal(tools.length, 1, '要注册一个工具')
  assert.equal(tools[0].name, 'group_memory_lookup')
})

test('tool: render 必须返回内容块数组（dsh 会调 content.some）', () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = captured.def.output.render({}, { found: 1, text: 'hi' })
  assert.ok(Array.isArray(out), 'render 必须返回数组，裸字符串会让 dsh 的 content.some 报错')
  assert.equal(out[0].type, 'text')
  assert.equal(out[0].text, 'hi')
})

test('tool: render 空值也返回数组', () => {
  const { ctx, captured } = makeToolCtx()
  registerMemoryTool(ctx, makeToolRuntime(), { trusted: true })
  const out = captured.def.output.render({}, undefined)
  assert.ok(Array.isArray(out))
  assert.equal(out[0].type, 'text')
})
