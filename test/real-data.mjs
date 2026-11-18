// 用真实的 IM 群历史 + 真实的插件 store 跑一遍召回，mock 掉 agent
import { createStore } from '../lib/store.js'
import { createConfigStore } from '../lib/config.js'
import { createEmbedder } from '../lib/embed.js'
import { createImReader } from '../lib/dshim.js'
import { recallSync, formatMemoryBlock } from '../lib/recall.js'

const dataDir = '/root/.dsh/plugins/dsh-group-vector-memory'
const configStore = createConfigStore(dataDir)
const store = createStore(dataDir)
const embedder = createEmbedder(configStore)
const im = createImReader()

const cfg = configStore.get()
console.log('配置模型:', cfg.embedding.model, '| Key 已设置:', Boolean(cfg.embedding.apiKey))
console.log('store 里的消息:', store.stats().messages, '条，向量化', store.stats().embedded, '条')
console.log('IM 库:', im.available() ? '可用' : '不可用', '| 群:', im.groups().map(g => g.channel).join(','))

const rows = im.since(0, 200)
const bySender = new Map()
for (const r of rows) {
  if (!bySender.has(r.senderId)) bySender.set(r.senderId, { name: r.senderName, count: 0 })
  bySender.get(r.senderId).count += 1
}
console.log('\n按人统计:')
for (const [sid, v] of bySender) console.log(' ', v.name || '(无名)', sid.slice(0, 12), v.count, '条')

// 对每个发过言的人跑一次召回
for (const [sid, v] of bySender) {
  const last = rows.filter(r => r.senderId === sid).at(-1)
  const { recent, semantic } = recallSync({ store, senderId: sid, query: last?.text || '', cfg })
  const block = formatMemoryBlock({ senderName: v.name, userId: sid, recent, semantic, maxChars: cfg.inject.maxChars })
  console.log(`\n=== 注入预览：${v.name || sid.slice(0, 10)} ===`)
  console.log(block)
}
store.close()
