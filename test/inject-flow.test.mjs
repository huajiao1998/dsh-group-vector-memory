import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installInjector } from '../lib/inject.js'
import { defaultImPath } from '../lib/dshim.js'

test('运行中的工作区与总开关改动会更新已挂载会话，卸载时移除工具', async () => {
  const handlers = new Map()
  const tools = new Map()
  const agent = {
    session: { id: 'test', cwd: '/allowed' },
    ctx: {
      on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
      tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    },
  }
  let cfg = { enabled: true, workspaces: ['/allowed'], inject: { enabled: true }, recall: { semantic: 0 } }
  const runtime = {
    configStore: { get: () => cfg },
    ctx: { tools: { get: name => ({ name, execute: async () => ({ groupName: '合成群', items: [] }) }) } },
    imReader: { path: defaultImPath(), groups: () => [{ id: 'local', name: '合成群', channel: 'qq', platform_group_id: 'g1' }] },
    store: {},
    recall: () => ({ recent: [{ text: '合成发言' }], semantic: [], literal: [] }),
    format: ({ recent }) => recent[0].text,
  }
  const off = installInjector({ agents: { list: () => [agent] } }, runtime)
  const messages = [{
    role: 'user', source: { kind: 'user', rpcId: 'qq-00000000-0000-4000-8000-000000000001' },
    content: [{ type: 'text', text: '<dsh_im_source>{"channel":"qq","chatId":"g1","senderId":"u1"}</dsh_im_source>\n合成查询' }],
  }]
  const step = (turn) => handlers.get('agent/pre-step')({ turn, messages }, async () => ({ kind: 'enter', messages }))
  try {
    assert.equal((await step(1)).messages.length, 2)
    assert.ok(tools.has('group_memory_lookup'))
    cfg = { ...cfg, workspaces: ['/other'] }
    runtime.refreshAgentScopes()
    assert.ok(!tools.has('group_memory_lookup'))
    assert.equal((await step(2)).messages.length, 1)
    cfg = { ...cfg, workspaces: [] }
    runtime.refreshAgentScopes()
    assert.equal((await step(3)).messages.length, 2)
    cfg = { ...cfg, enabled: false }
    runtime.refreshAgentScopes()
    assert.ok(!tools.has('group_memory_lookup'))
    assert.equal((await step(4)).messages.length, 1)
  } finally {
    off()
  }
  assert.equal(handlers.size, 0)
  assert.equal(tools.size, 0)
})
