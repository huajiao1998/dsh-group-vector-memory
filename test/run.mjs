import { installInjector } from '../lib/inject.js'

const messages = [
  { sender: 'u1', text: '上周说过想学吉他', sentAt: 1 },
  { sender: 'u1', text: '第24支你打算做什么？', sentAt: 2 },
]
const runtime = {
  configStore: { get: () => ({ enabled: true, inject: { enabled: true, maxChars: 2000 }, recall: { recent: 10, semantic: 0, minScore: 0 } }) },
  store: {
    stats: () => ({ messages: messages.length }),
    recentBySender: (sid, n) => messages.filter(m => m.sender === sid).slice(-n),
    vectorsBySender: () => [],
  },
  embedder: { embedOne: async () => null },
}
const handlers = []
const agent = { injected: [], inject(m) { this.injected.push(m) } }
const ctx = {
  on: (n, f) => handlers.push({ n, f }),
  logger: { warn: (...a) => console.log('[warn]', ...a) },
  agents: { get: () => agent },
}
installInjector(ctx, runtime)

const ev = {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '<dsh_im_source>{"channel":"qq","senderId":"u1","senderName":"王阿牛","chatId":"g1"}</dsh_im_source>\n第24支你打算做什么？' }] },
}
handlers.find(h => h.n === 'session/event').f({ id: 's1' }, ev)

console.log('注入次数:', agent.injected.length)
if (agent.injected.length) {
  console.log('--- 注入内容 ---')
  console.log(agent.injected[0].content[0].text)
}
