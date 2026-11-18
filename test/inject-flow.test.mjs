console.log("START")
import assert from 'node:assert/strict'
import { installInjector } from '../lib/inject.js'

// ---- 假的运行时 ----
function makeRuntime({ messages = [], vectors = [] } = {}) {
  return {
    configStore: {
      get: () => ({ enabled: true, inject: { enabled: true, maxChars: 2000 }, recall: { recent: 10, semantic: 5, minScore: 0.0 } }),
    },
    store: {
      stats: () => ({ messages: messages.length }),
      recentBySender: (sid, n) => messages.filter(m => m.sender === sid).slice(-n),
      vectorsBySender: (sid) => vectors.filter(v => v.sender === sid),
    },
    embedder: { embedOne: async () => ({ vector: new Float32Array([1, 0, 0]), dims: 3, ms: 1 }) },
  }
}

function makeCtx(agent) {
  const handlers = []
  return {
    ctx: {
      on: (name, fn) => handlers.push({ name, fn }),
      logger: { warn: (...a) => console.log('  [warn]', ...a) },
      agents: { get: () => agent },
    },
    fire: (session, event) => handlers.forEach(h => h.name === 'session/event' && h.fn(session, event)),
  }
}

const mkEvent = (meta, text = '第24支你打算做什么？') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text: `<dsh_im_source>${JSON.stringify(meta)}</dsh_im_source>\n${text}` }] },
})

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name) }
  catch (e) { fail++; console.log('  ✗', name, '→', e.message) }
}

// 同步注入：inject 是同步调用，listener 里也是同步，所以等待一个 tick 即可
const tick = () => new Promise(r => setTimeout(r, 0))

(async () => {
  console.log('注入流程:')

  await t('群消息 → 调 agent.inject，内容含发言最近记录', async () => {
    const agent = { injected: [], inject(m) { this.injected.push(m) } }
    const runtime = makeRuntime({
      messages: [
        { sender: 'u1', text: '上周说过想学吉他', sentAt: 1 },
        { sender: 'u1', text: '第24支你打算做什么？', sentAt: 2 },
      ],
    })
    const { ctx, fire } = makeCtx(agent)
    installInjector(ctx, runtime)
    fire({ id: 's1' }, mkEvent({ channel: 'qq', senderId: 'u1', senderName: '王阿牛', chatId: 'g1' }))
    await tick()
    assert.equal(agent.injected.length, 1, '应该注入一次')
    const text = agent.injected[0].content[0].text
    assert.match(text, /王阿牛/)
    assert.match(text, /第24支你打算做什么/)
  })

  await t('私聊（无 chatId、无 conversationType）→ 不注入', async () => {
    const agent = { injected: [], inject(m) { this.injected.push(m) } }
    const runtime = makeRuntime({ messages: [{ sender: 'u1', text: 'hi', sentAt: 1 }] })
    const { ctx, fire } = makeCtx(agent)
    installInjector(ctx, runtime)
    fire({ id: 's1' }, mkEvent({ channel: 'qq', senderId: 'u1' }))
    await tick()
    assert.equal(agent.injected.length, 0)
  })

  await t('同一人短时间重复发 → 只注入一次（TTL 内去重）', async () => {
    const agent = { injected: [], inject(m) { this.injected.push(m) } }
    const runtime = makeRuntime({ messages: [{ sender: 'u1', text: '同一句', sentAt: 1 }] })
    const { ctx, fire } = makeCtx(agent)
    installInjector(ctx, runtime)
    const ev = mkEvent({ channel: 'qq', senderId: 'u1', senderName: '王阿牛', chatId: 'g1' })
    fire({ id: 's1' }, ev)
    fire({ id: 's1' }, ev)
    await tick()
    assert.equal(agent.injected.length, 1, 'TTL 内应只注入一次')
  })

  await t('普通消息（无 source）→ 不注入', async () => {
    const agent = { injected: [], inject(m) { this.injected.push(m) } }
    const { ctx, fire } = makeCtx(agent)
    installInjector(ctx, makeRuntime())
    fire({ id: 's1' }, { type: 'user/message', data: { content: [{ type: 'text', text: '普通消息' }] } })
    await tick()
    assert.equal(agent.injected.length, 0)
  })

  await t('拿不到 agent → 不抛错', async () => {
    const { ctx, fire } = makeCtx(undefined)
    installInjector(ctx, makeRuntime({ messages: [{ sender: 'u1', text: 'x', sentAt: 1 }] }))
    fire({ id: 's1' }, mkEvent({ channel: 'qq', senderId: 'u1', chatId: 'g1' }))
    await tick()
  })

  console.log(`\n${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
