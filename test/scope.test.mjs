import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createStore } from '../lib/store.js'
import { installInjector, mountAgent } from '../lib/inject.js'
import { formatMemoryBlock, recallAsync, recallSync } from '../lib/recall.js'
import { memoryToolDefinition } from '../lib/tool.js'

const vector = new Float32Array([1, 0])
const archivePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-im', 'group-history.sqlite')
const groups = [
  { id: 'archive-a', channel: 'qq', platform_group_id: 'chat-a', name: 'Fixture A' },
  { id: 'archive-b', channel: 'qq', platform_group_id: 'chat-b', name: 'Fixture B' },
  { id: 'archive-c', channel: 'feishu', platform_group_id: 'chat-a', name: 'Fixture C' },
]
const groupMessage = (meta = {}, rpc = 'qq-00000000-0000-4000-8000-000000000001', wrapper = true) => ({
  role: 'user',
  source: { kind: 'user', rpcId: rpc },
  content: [{ type: 'text', text: `${wrapper ? '' : 'body before metadata\n'}<dsh_im_source>${JSON.stringify({ channel: 'qq', senderId: 'person-1', senderName: 'Name A', chatId: 'chat-a', ...meta })}</dsh_im_source>\n\nkeyword` }],
})

function splitGroupMessage(meta = {}, rpc) {
  const original = groupMessage({ conversationType: 'group', ...meta }, rpc)
  const [source] = original.content[0].text.split('\n\n')
  const notice = text => ({ role: 'user', source: { kind: 'plugin:dsh-im', form: 'notice' }, content: [{ type: 'text', text }] })
  return [
    notice('<dsh_im_reply_to>{}</dsh_im_reply_to>'),
    { ...original, content: [{ type: 'text', text: 'keyword' }] },
    notice(source),
  ]
}

function fixture(t, { mounted = true } = {}) {
  const cfg = { enabled: true, workspaces: ['/in'], inject: { enabled: true }, recall: { recent: 1, semantic: 8, minScore: 0.5 } }
  const dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-scope-'))
  const store = createStore(dir.path)
  t.after(() => { try { store.close() } finally { dir.remove() } })
  store.upsertGroups(groups)
  store.upsertMessages([
    { id: 'a1', groupId: 'archive-a', senderId: 'person-1', senderName: 'Name A', text: 'keyword allowed', sentAt: 1 },
    { id: 'a2', groupId: 'archive-a', senderId: 'person-1', senderName: 'Name A', text: 'recent allowed', sentAt: 2 },
    { id: 'b1', groupId: 'archive-b', senderId: 'person-1', senderName: 'Name B', text: 'keyword outside', sentAt: 3 },
    { id: 'b2', groupId: 'archive-b', senderId: 'person-2', senderName: 'Outside Person', text: 'outside person', sentAt: 4 },
    { id: 'c1', groupId: 'archive-c', senderId: 'person-1', senderName: 'Name C', text: 'keyword other platform', sentAt: 5 },
  ])
  for (const [id, text] of [['a1', 'keyword allowed'], ['b1', 'keyword outside'], ['c1', 'keyword other platform']]) store.setEmbedding(id, vector, text)
  const callbacks = new Map()
  const def = new Map()
  const agent = {
    session: { id: 'test-agent', header: { cwd: '/in' } },
    ctx: {
      on(name, fn) { callbacks.set(name, fn); return () => callbacks.delete(name) },
      tools: { register(d) { def.set(d.name, d); return () => def.delete(d.name) } },
    },
  }
  let hostLabel = 'Fixture A'
  let archive = groups
  let hostRequests = 0
  let embeddingCalls = 0
  const runtime = {
    ctx: { tools: { get(name) {
      if (name !== 'dsh_im_group_history') return undefined
      return { name, async execute(args, exec) {
        hostRequests++
        assert.equal(exec.agent, agent)
        assert.equal(args.kind, 'files')
        assert.equal(args.limit, 1)
        assert.equal(args.from, args.to)
        assert.ok(args.keyword)
        assert.equal(Object.hasOwn(args, 'cursor'), false)
        if (!hostLabel) throw new Error('host denied')
        return { groupName: hostLabel, items: [] }
      } }
    } } },
    store,
    imReader: { path: archivePath, groups: () => archive },
    configStore: { get: () => structuredClone(cfg) },
    async embedOne() { embeddingCalls++; return { vector } },
    recall(senderId, query, queryVec, groupId) { return recallSync({ store, senderId, query, queryVec, groupId, cfg }) },
    format: formatMemoryBlock,
  }
  if (mounted) t.after(mountAgent(agent, runtime))
  const exec = () => ({ agent, signal: new AbortController().signal })
  return {
    agent, runtime, cfg, store,
    setHostLabel(value) { hostLabel = value },
    setArchive(value) { archive = value },
    hostRequests: () => hostRequests,
    embeddingCalls: () => embeddingCalls,
    tool: () => def.get('group_memory_lookup'),
    call(args, definition = def.get('group_memory_lookup')) { return definition.execute(args, exec()) },
    step(messages, turn = 1, next = async () => ({ kind: 'enter', messages })) {
      return callbacks.get('agent/pre-step')({ messages, turn, step: 1, signal: exec().signal }, next)
    },
  }
}

const memory = decision => decision.messages.at(-1)?.source?.kind === 'group-vector-memory' ? decision.messages.at(-1) : null

test('recent, literal and semantic candidates are filtered by group before limiting', t => {
  const f = fixture(t)
  const result = recallSync({ store: f.store, senderId: 'person-1', query: 'keyword', queryVec: vector, groupId: 'archive-a', cfg: f.cfg })
  assert.deepEqual(result.recent.map(r => r.id), ['a2'])
  assert.deepEqual(result.literal.map(r => r.id), ['a1'])
  assert.deepEqual(result.semantic.map(r => r.id), ['a1'])
  assert.deepEqual(recallSync({ store: f.store, senderId: 'person-1', query: 'keyword', queryVec: vector, groupId: '', cfg: f.cfg }), { recent: [], literal: [], semantic: [] })
})

test('pre-step and tool use the same authorized group; another channel may share the platform ID', async t => {
  const f = fixture(t)
  const msg = groupMessage()
  const snapshot = memory(await f.step([msg]))
  assert.ok(snapshot)
  assert.equal(snapshot.source.rpcId, msg.source.rpcId)
  assert.match(snapshot.content[0].text, /recent allowed/)
  assert.match(snapshot.content[0].text, /keyword allowed/)
  assert.doesNotMatch(snapshot.content[0].text, /outside|other platform/)
  assert.equal(f.tool().parameters.properties.groupId, undefined)
  const result = await f.call({ person: 'person-1', query: 'keyword' })
  assert.equal(result.found, 1)
  assert.match(result.text, /共 2 条记录/)
  assert.match(result.text, /keyword allowed/)
  assert.doesNotMatch(result.text, /outside|other platform/)
  assert.deepEqual(f.tool().output.render({}, result), [{ type: 'text', text: result.text }])
  const missing = await f.call({ person: 'Outside Person' })
  assert.equal(missing.found, 0)
  assert.doesNotMatch(missing.text, /Name B|Name C/)
  assert.equal((await f.call({ person: 'person-1', groupId: 'archive-b' })).found, 0)
  assert.equal((await f.call({ person: 'person-1', groupId: 'archive-a' })).found, 0)
  assert.equal(f.hostRequests(), 4)
})

test('QQ bare mention follow-up runs one authorized query with nearby matching context', async t => {
  const f = fixture(t)
  const queries = []
  f.runtime.embedOne = async query => { queries.push(query); return { vector } }
  const previous = text => `<dsh_im_context>${JSON.stringify({ collector: 'qq-mention-followup', content: text })}</dsh_im_context>`
  const withBody = body => {
    const message = groupMessage()
    message.content[0].text = message.content[0].text.replace(/keyword$/, body)
    return message
  }
  const main = '一天睡多久阿'
  assert.ok(memory(await f.step([withBody(`${previous('小鱼也喜欢睡觉吗')}\n\n${main}`)])))
  assert.ok(memory(await f.step([withBody(`${previous('今天记得带伞')}\n\n${main}`)], 2)))
  assert.ok(memory(await f.step([withBody('一条新的正文')], 3)))
  assert.deepEqual(queries, [`${main}\n小鱼也喜欢睡觉吗`, main, '一条新的正文'])
  f.setHostLabel('')
  assert.equal(memory(await f.step([withBody(`${previous('小鱼也喜欢睡觉吗')}\n\n${main}`)], 4)), null)
  assert.equal(queries.length, 3)
})

test('missing, forged, ambiguous, private or mixed group origins do not perform recall', async t => {
  const f = fixture(t)
  const good = groupMessage()
  for (const messages of [
    [groupMessage({ chatId: 'unknown' })],
    [groupMessage({ conversationType: 'direct' })],
    [groupMessage({}, 'web-00000000-0000-4000-8000-000000000001')],
    [groupMessage({}, undefined, false)],
    [good, groupMessage({ chatId: 'chat-b' })],
    [good, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'web user' }] }],
  ]) assert.equal(memory(await f.step(messages)), null)
  assert.equal(f.hostRequests(), 0)
  f.setHostLabel('Fixture B')
  assert.equal(memory(await f.step([good])), null)
  assert.equal((await f.call({ person: 'person-1' })).found, 0)
  f.setHostLabel('Fixture A')
  f.setArchive([...groups, { ...groups[1], name: 'Fixture A' }])
  assert.equal(memory(await f.step([good])), null)
  f.setArchive([...groups, { ...groups[0], id: 'duplicate', name: 'other bot' }])
  assert.equal(memory(await f.step([good])), null)
  f.setArchive(groups)
  f.runtime.imReader.path = '/tmp/other-group-history.sqlite'
  assert.equal(memory(await f.step([good])), null)
  assert.equal(f.embeddingCalls(), 0)
})

test('authorized turn may continue across steps but cannot carry to another turn', async t => {
  const f = fixture(t)
  assert.ok(memory(await f.step([groupMessage()])))
  await f.step([])
  assert.equal((await f.call({ person: 'person-1' })).found, 2)
  f.setHostLabel(null)
  assert.equal((await f.call({ person: 'person-1' })).found, 0)
  f.setHostLabel('Fixture A')
  await f.step([], 2)
  assert.equal((await f.call({ person: 'person-1' })).found, 0)
})

test('disabled and workspace-excluded agents react to live changes', async t => {
  const f = fixture(t, { mounted: false })
  f.cfg.enabled = false
  t.after(installInjector({ agents: { list: () => [f.agent] } }, f.runtime))
  assert.equal(f.tool(), undefined)
  assert.equal(memory(await f.step([groupMessage()])), null)
  f.cfg.enabled = true
  f.runtime.refreshAgentScopes()
  assert.ok(f.tool())
  const stale = f.tool()
  assert.ok(memory(await f.step([groupMessage()])))
  f.cfg.workspaces = ['/other']
  f.runtime.refreshAgentScopes()
  assert.equal(f.tool(), undefined)
  assert.equal((await f.call({ person: 'person-1' }, stale)).found, 0)
  assert.equal(memory(await f.step([groupMessage()])), null)
  f.cfg.workspaces = ['/in']
  assert.ok(memory(await f.step([groupMessage()])))
  assert.equal((await f.call({ person: 'person-1' })).found, 2)
})

test('embedding rejection falls back locally and semantic=0 performs no embedding', async t => {
  const f = fixture(t)
  let calls = 0
  f.runtime.embedOne = async () => { calls++; throw Error('synthetic failure') }
  let snapshot = memory(await f.step([groupMessage()]))
  assert.match(snapshot.content[0].text, /recent allowed/)
  assert.match(snapshot.content[0].text, /keyword allowed/)
  assert.match((await f.call({ person: 'person-1', query: 'keyword' })).text, /keyword allowed/)
  f.cfg.recall.semantic = 0
  snapshot = memory(await f.step([groupMessage()]))
  assert.match(snapshot.content[0].text, /keyword allowed/)
  assert.match((await f.call({ person: 'person-1', query: 'keyword' })).text, /keyword allowed/)
  assert.equal(calls, 2)
})

test('slow embedding is aborted at the short deadline; local fallback survives', async t => {
  const f = fixture(t)
  const signals = []
  f.runtime.embedOne = (_text, { signal }) => { signals.push(signal); return new Promise(() => {}) }
  // The production server already keeps the loop alive; this test fixture needs a ref while checking an unref'd timer.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const time = performance.now()
    assert.match(memory(await f.step([groupMessage()])).content[0].text, /keyword allowed/)
    assert.match((await f.call({ person: 'person-1', query: 'keyword' })).text, /keyword allowed/)
    assert.ok(performance.now() - time < 1800)
    assert.deepEqual(signals.map(s => s.aborted), [true, true])
  } finally {
    clearInterval(keepAlive)
  }
})

test('live gating is checked when in-flight embedding completes', async t => {
  const f = fixture(t)
  f.runtime.embedOne = async () => { f.cfg.enabled = false; return { vector } }
  assert.equal(memory(await f.step([groupMessage()])), null)
  f.cfg.enabled = true
  f.cfg.recall.semantic = 0
  assert.ok(memory(await f.step([groupMessage()])))
  f.cfg.recall.semantic = 8
  f.runtime.embedOne = async () => { await delay(1); f.cfg.workspaces = ['/outside']; return { vector } }
  assert.equal((await f.call({ person: 'person-1', query: 'keyword' })).found, 0)
})

test('preview retains literal results and non-agent admin opt-in retains broad queries', async t => {
  const f = fixture(t)
  const preview = await recallAsync({ store: f.store, embedder: { async embedOne() { return { vector } } }, senderId: 'person-1', query: 'keyword', groupId: 'archive-a', cfg: f.cfg })
  assert.deepEqual(preview.literal.map(r => r.id), ['a1'])
  assert.deepEqual(preview.semantic.map(r => r.id), ['a1'])
  const admin = memoryToolDefinition(f.runtime, { trusted: true })
  assert.equal((await admin.execute({ person: 'person-1' }, { agent: f.agent })).found, 0)
  assert.match((await admin.execute({ person: 'person-1' })).text, /keyword outside/)
  assert.equal((await memoryToolDefinition(f.runtime).execute({ person: 'person-1' })).found, 0)
})

test('dsh-im split notices preserve recall and bind the snapshot to the real request', async t => {
  const f = fixture(t)
  const messages = splitGroupMessage()
  const snapshot = memory(await f.step(messages))
  assert.equal(snapshot?.source.rpcId, messages[1].source.rpcId)
  assert.match(snapshot.content[0].text, /recent allowed/)
  assert.match(snapshot.content[0].text, /keyword allowed/)
  assert.doesNotMatch(snapshot.content[0].text, /outside|other platform/)
  assert.equal((await f.call({ person: 'person-1', query: 'keyword' })).found, 1)
  f.setHostLabel('Fixture B')
  assert.equal(memory(await f.step(messages)), null)
  assert.equal((await f.call({ person: 'person-1' })).found, 0)
})

test('unpaired, conflicting, private or untrusted source notices are not accepted', async t => {
  const f = fixture(t)
  const [, msg, notice] = splitGroupMessage()
  for (const messages of [
    [msg], [notice, msg], [msg, notice, notice], [groupMessage(), notice],
    [msg, { ...notice, source: { kind: 'plugin:other', form: 'notice' } }],
    splitGroupMessage({ channel: 'feishu' }),
    splitGroupMessage({ conversationType: 'direct' }),
    splitGroupMessage({}, 'web-00000000-0000-4000-8000-000000000001'),
    [msg, notice, ...splitGroupMessage({ chatId: 'chat-b' })],
  ]) assert.equal(memory(await f.step(messages)), null)
  assert.equal(f.hostRequests(), 0)
})

test('agent creation mounts immediately using the declared host workspace service', async t => {
  const f = fixture(t, { mounted: false })
  Object.defineProperty(f.agent.ctx, 'workingDirectory', { get() { throw new Error('cannot get property "workingDirectory" without inject') } })
  let cwd = '/in'
  f.runtime.workingDirectory = { get(session) { assert.equal(session, f.agent.session); return cwd } }
  const lifecycle = new Map()
  const dispose = installInjector({
    agents: { list: () => [] },
    on(name, fn, options) { assert.equal(options.global, true); lifecycle.set(name, fn); return () => lifecycle.delete(name) },
  }, f.runtime)
  t.after(dispose)
  assert.equal(f.tool(), undefined)
  lifecycle.get('agent/created')({ agent: f.agent })
  assert.ok(f.tool())
  const wrapped = groupMessage({ conversationType: 'group' })
  const split = splitGroupMessage()
  assert.ok(memory(await f.step([wrapped], 1, async () => ({ kind: 'enter', messages: split }))))
  cwd = '/outside'
  assert.equal(memory(await f.step(split, 2)), null)
  cwd = '/in'
  assert.ok(memory(await f.step(split, 3)))
  lifecycle.get('agent/disposed')({ agent: f.agent })
  assert.equal(f.tool(), undefined)
})
