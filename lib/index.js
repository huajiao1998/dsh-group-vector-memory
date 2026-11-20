import { createConfigStore } from './config.js'
import { createEmbedder } from './embed.js'
import { createStore } from './store.js'
import { createImReader, defaultImPath } from './dshim.js'
import { createRpc } from './rpc.js'
import { installInjector } from './inject.js'
import { registerMemoryTool } from './tool.js'
import { recallSync, cleanText } from './recall.js'
import { formatMemoryBlock } from './recall.js'

export const name = 'dsh-group-vector-memory'
export const inject = ['connection', 'systemPrompt', 'agents', 'tools']

const WATCH_INTERVAL_MS = 200      // 快速扫描 IM 库，抢在消息进会话之前把向量算好
const INITIAL_DELAY_MS = 3000
const BATCH_LIMIT = 500
const EMBED_BATCH = 100

function resolveDataDir(config) {
  if (config?.dataDir) return config.dataDir
  const home = process.env.HOME || '/root'
  return `${home}/.dsh/plugins/dsh-group-vector-memory`
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const configStore = createConfigStore(dataDir)
  const embedder = createEmbedder(configStore)
  const store = createStore(dataDir)
  const imReader = createImReader(config.imPath || defaultImPath())

  const runtime = { ctx, config, dataDir, configStore, embedder, store, imReader, syncing: null }

  // 统一日志出口：debug 打开才输出，平时静默（老板要求：没事别刷日志）
  runtime.log = (message) => {
    try {
      if (!configStore.get()?.debug) return
      console.log(message)
    } catch {}
  }

  // inject.js 里 section 的 text 调这两个（同步、零网络）
  runtime.recall = (senderId, query, queryVec) => {
    const cfg = configStore.get()
    // 预向量化缓存优先：消息刚进 IM 库时已经算好向量，但还没走 30 秒的批量入库，
    // 只从 SQLite 里找会找不到 → 语义召回空。缓存里按「清理后的文本」存。
    const cached = queryVec || vecCache.get(String(query || '').trim()) || null
    return recallSync({ store, senderId, query, queryVec: cached, cfg })
  }
  // 预向量化缓存：text -> vector。消息一进 IM 库就算好，等它进 agent inbox 时直接命中
  const vecCache = new Map()
  const VEC_CACHE_MAX = 2000
  runtime.embedOne = async (text) => {
    const key = String(text || '').trim()
    if (!key) return null
    if (vecCache.has(key)) return { vector: vecCache.get(key), dims: vecCache.get(key).length, cached: true }
    const r = await embedder.embedOne(key)
    if (r?.vector) {
      vecCache.set(key, r.vector)
      if (vecCache.size > VEC_CACHE_MAX) vecCache.delete(vecCache.keys().next().value)
    }
    return r
  }
  runtime.peekVector = (text) => vecCache.get(String(text || '').trim()) || null

  // 快速扫描：只做「发现新消息 → 向量化进缓存」，不等批量同步
  runtime.watchNew = async function watchNew() {
    if (runtime.watching) return
    runtime.watching = true
    try {
      const cfg = configStore.get()
      if (!cfg.enabled || !cfg.embedding?.model) return
      if (!imReader.available()) return
      const rows = imReader.since(runtime.lastSentAt || 0, 50)
      if (!rows.length) return
      for (const r of rows) {
        const raw = String(r.text || '').trim()
        if (!raw) continue
        const text = cleanText(raw)          // 跟 context 里的 query 用同一套清理，缓存才命中
        if (!text || vecCache.has(text)) continue
        try {
          const v = await runtime.embedOne(text)
          if (v?.vector) runtime.log(`[gvm-vec] 预向量化 ${r.senderName || r.senderId.slice(0, 8)}「${text.slice(0, 16)}」${v.dims} 维`)
        } catch (e) {
          runtime.log(`[gvm-vec] 预向量化失败: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
      }
      const newest = Math.max(...rows.map(r => Number(r.sentAt) || 0))
      if (newest > runtime.lastSentAt) runtime.lastSentAt = newest
    } finally {
      runtime.watching = false
    }
  }
  runtime.format = ({ senderName, userId, recent, semantic }) => {
    const cfg = configStore.get()
    return formatMemoryBlock({ senderName, userId, recent, semantic, maxChars: cfg.inject.maxChars })
  }

  // 同步进度持久化：重载后不会从头重读
  const metaKey = 'last_sent_at'
  runtime.lastSentAt = Number(store.getMeta(metaKey, 0)) || 0

  runtime.syncOnce = async function syncOnce() {
    if (runtime.syncing) return runtime.syncing
    runtime.syncing = (async () => {
      const cfg = configStore.get()
      if (!cfg.enabled) return { added: 0, embedded: 0, skipped: '插件已禁用' }
      const lastSentAt = runtime.lastSentAt || 0
      const rows = imReader.available() ? imReader.since(lastSentAt, BATCH_LIMIT) : []
      if (rows.length === 0) return { added: 0, embedded: 0, lastSentAt }
      const added = store.upsertMessages(rows)
      const newest = Math.max(...rows.map(r => Number(r.sentAt) || 0))
      if (newest > runtime.lastSentAt) {
        runtime.lastSentAt = newest
        store.setMeta(metaKey, newest)
      }
      if (!cfg.embedding?.model) return { added, embedded: 0, skipped: 'embedding 未配置', lastSentAt: runtime.lastSentAt }
      const pending = store.pendingEmbeddings(EMBED_BATCH)
      let embedded = 0
      let failed = 0
      let embedError = null
      let consecutive = 0
      for (const p of pending) {
        try {
          const r = await embedder.embedOne(p.text)
          if (r?.vector) { store.setEmbedding(p.id, r.vector); embedded += 1 }
          consecutive = 0
        } catch (e) {
          // 单条内容问题跳过继续，连续失败说明接口挂了，停下等下一轮
          failed += 1
          embedError = e instanceof Error ? e.message : String(e)
          consecutive += 1
          if (consecutive >= 3) break
        }
      }
      return { added, embedded, failed, lastSentAt: runtime.lastSentAt, ...(embedError ? { embedError } : {}) }
    })().finally(() => { runtime.syncing = null })
    return runtime.syncing
  }

  // ---- 资源注册：全部挂到 ctx.effect，热重载时自动清理 ----
  // 事件监听必须直接挂在 apply 的 ctx 上（放进 effect 回调里会挂不上）
  const offInjector = installInjector(ctx, runtime)
  // 模型主动查询工具：ctx.tools.register 内部自己挂 effect，不用手动清
  registerMemoryTool(ctx, runtime)

  ctx.effect(() => {
    ctx.connection.rpc.handle('/gvm', createRpc(runtime))

    const kick = () => { runtime.syncOnce().catch(() => {}) }
    const watch = () => { runtime.watchNew().catch(() => {}) }
    const initial = setTimeout(kick, INITIAL_DELAY_MS)
    const syncTimer = setInterval(kick, 30000)
    const watchTimer = setInterval(watch, WATCH_INTERVAL_MS)
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
    if (typeof watchTimer.unref === 'function') watchTimer.unref()
    if (typeof initial.unref === 'function') initial.unref()

    return () => {
      clearTimeout(initial)
      clearInterval(syncTimer)
      clearInterval(watchTimer)
      if (typeof offInjector === 'function') offInjector()
      try { store.close() } catch {}
      try { imReader.close() } catch {}
    }
  }, 'dsh-group-vector-memory: resources')

  console.log(`[gvm] ready: ${dataDir}`)
  return runtime
}
