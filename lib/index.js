import { createConfigStore } from './config.js'
import { createEmbedder, embeddingSpace } from './embed.js'
import { createStore } from './store.js'
import { createImReader, defaultImPath } from './dshim.js'
import { createQqInfoReader, defaultQqChatPath } from './qqinfo.js'
import { createRpc } from './rpc.js'
import { createEmbeddingRebuild } from './rebuild.js'
import { installInjector } from './inject.js'
import { recallSync, cleanText } from './recall.js'
import { formatMemoryBlock } from './recall.js'

export const name = 'dsh-group-vector-memory'
export const inject = ['connection', 'systemPrompt', 'agents', 'tools', 'workspaceRegistry']

const WATCH_INTERVAL_MS = 200      // 快速扫描 IM 库，抢在消息进会话之前把向量算好
const INITIAL_DELAY_MS = 3000
const BATCH_LIMIT = 500
const EMBED_BATCH = 100

function resolveDataDir(config) {
  if (config?.dataDir) return config.dataDir
  const home = process.env.HOME || '/root'
  return `${home}/.dsh/plugins/dsh-group-vector-memory`
}

function canEmbed(cfg) {
  return cfg.enabled && cfg.embedding?.enabled !== false && Boolean(cfg.embedding?.baseUrl && cfg.embedding?.model)
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const configStore = createConfigStore(dataDir)
  const embedder = createEmbedder(configStore)
  const store = createStore(dataDir)
  const imReader = createImReader(config.imPath || defaultImPath())
  const qqInfo = createQqInfoReader(config.qqchatPath || defaultQqChatPath())

  const runtime = { ctx, config, dataDir, configStore, embedder, store, imReader, qqInfo, syncing: null }

  // 统一日志出口：debug 打开才输出，平时静默（老板要求：没事别刷日志）
  runtime.log = (message) => {
    try {
      if (!configStore.get()?.debug) return
      console.log(message)
    } catch {}
  }

  runtime.refreshEmbeddingSpace = (cfg = configStore.get()) => {
    const space = canEmbed(cfg) ? embeddingSpace(cfg) : 'disabled'
    store.useEmbeddingSpace(space)
    return space
  }
  runtime.refreshEmbeddingSpace()

  runtime.recall = (senderId, query, queryVec, groupId) => {
    const cfg = configStore.get()
    if (!cfg.enabled || !groupId) return { recent: [], semantic: [], literal: [] }
    runtime.refreshEmbeddingSpace(cfg)
    const recallCfg = canEmbed(cfg) ? cfg : { ...cfg, recall: { ...cfg.recall, semantic: 0 } }
    return recallSync({ store, senderId, groupId, query, queryVec, cfg: recallCfg })
  }
  runtime.embedOne = async (text, { signal } = {}) => {
    const cfg = configStore.get()
    if (!canEmbed(cfg)) return null
    const result = await embedder.embedOne(text, { config: cfg, signal })
    return runtime.refreshEmbeddingSpace() === embeddingSpace(cfg) ? result : null
  }

  // 快速扫描：只做「发现新消息 → 向量化进缓存」，不等批量同步
  runtime.watchNew = async function watchNew() {
    if (runtime.watching) return
    runtime.watching = true
    try {
      const cfg = configStore.get()
      if (!canEmbed(cfg) || !imReader.available()) return
      // 老历史只从入库后的有效文本生成向量，预热只看即时收到的消息。
      if (runtime.watchCursor === undefined) {
        runtime.watchCursor = imReader.latestArrival()
        return
      }
      const rows = imReader.sinceArrival(runtime.watchCursor, 50)
      if (!rows.length) return
      runtime.watchCursor = rows.at(-1).sourceSeq
      for (const row of rows) {
        if (!canEmbed(configStore.get())) break
        const text = cleanText(store.textForPrewarm(row))
        if (!text) continue
        try {
          await runtime.embedOne(text)
        } catch (e) {
          runtime.log(`[gvm-vec] 预向量化失败: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
      }
    } finally {
      runtime.watching = false
    }
  }
  runtime.format = ({ senderName, userId, recent, semantic, literal }) => {
    const cfg = configStore.get()
    return formatMemoryBlock({ senderName, userId, recent, semantic, literal, maxChars: cfg.inject.maxChars })
  }

  // 群名：QQ 机器人的 /v2/groups/{openid}/info 直接给 group_name
  // （一开始以为拿不到，是错的）。人工在设置页填的 name 优先级更高。
  runtime.refreshGroupNames = async function refreshGroupNames() {
    try {
      if (!qqInfo.available()) return 0
      const qqGroups = (store.groupInfo() || []).filter(g => g.channel === 'qq' && g.platformGroupId)
      if (!qqGroups.length) return 0
      const names = await qqInfo.groupNames(qqGroups.map(g => g.platformGroupId))
      let n = 0
      for (const [openid, info] of names) {
        try { store.setGroupAutoName(openid, info.name); n += 1 } catch {}
      }
      if (n) runtime.log(`[gvm-groups] 拉到 ${n} 个群名`)
      return n
    } catch (e) {
      runtime.log(`[gvm-groups] 拉群名失败: ${e instanceof Error ? e.message : String(e)}`)
      return 0
    }
  }

  async function embedBatch(rows, { space, configForRow, signal }) {
    let embedded = 0
    let failed = 0
    let embedError = null
    let consecutive = 0
    let interrupted = false
    for (const p of rows) {
      const live = configForRow()
      if (!live || runtime.refreshEmbeddingSpace(live) !== space) { interrupted = true; break }
      if (!store.needsEmbedding(p.id, p.text)) continue
      try {
        const r = await embedder.embedOne(p.text, { config: live, signal })
        const latest = configForRow()
        if (!latest || runtime.refreshEmbeddingSpace(latest) !== space) { interrupted = true; break }
        if (r?.vector && store.setEmbedding(p.id, r.vector, p.text, space)) embedded += 1
        consecutive = 0
      } catch (e) {
        if (!configForRow()) { interrupted = true; break }
        failed += 1
        embedError = e instanceof Error ? e.message : String(e)
        consecutive += 1
        if (consecutive >= 3) { interrupted = true; break }
      }
    }
    return { embedded, failed, interrupted, ...(embedError ? { embedError } : {}) }
  }

  runtime.rebuild = createEmbeddingRebuild({
    readConfig: configStore.get, canEmbed, refreshSpace: runtime.refreshEmbeddingSpace,
    store, embedBatch, batchSize: EMBED_BATCH, waitForSync: () => runtime.syncing,
  })

  runtime.syncOnce = async function syncOnce() {
    if (runtime.syncing) return runtime.syncing
    runtime.syncing = (async () => {
      const cfg = configStore.get()
      if (!cfg.enabled) return { added: 0, embedded: 0, skipped: '插件已禁用' }
      const sourceAvailable = imReader.available()
      if (sourceAvailable) store.upsertGroups(imReader.groups())
      const rows = sourceAvailable ? imReader.sinceArrival(store.getSyncCursor(), BATCH_LIMIT) : []
      const added = rows.length ? store.upsertMessages(rows, rows.at(-1).sourceSeq) : 0
      const space = runtime.refreshEmbeddingSpace(cfg)
      if (!canEmbed(cfg)) return { added, embedded: 0, skipped: '向量化未启用或未配置' }
      if (runtime.rebuild.running) return { added, embedded: 0, skipped: '正在后台重建向量' }
      const { interrupted: _interrupted, ...batch } = await embedBatch(store.pendingEmbeddings(EMBED_BATCH), {
        space, configForRow: () => runtime.disposed ? null : configStore.get(),
      })
      return { added, ...batch }
    })().finally(() => { runtime.syncing = null })
    return runtime.syncing
  }

  // ---- 资源注册：全部挂到 ctx.effect，热重载时自动清理 ----
  // 事件监听必须直接挂在 apply 的 ctx 上（放进 effect 回调里会挂不上）
  const offInjector = installInjector(ctx, runtime)
  // 查询工具不在这里全局注册 —— mountAgent 里按工作区、注册到 agent scope

  ctx.effect(() => {
    ctx.connection.rpc.handle('/gvm', createRpc(runtime))

    const kick = () => { runtime.syncOnce().catch(() => {}) }
    const watch = () => { runtime.watchNew().catch(() => {}) }
    const initial = setTimeout(kick, INITIAL_DELAY_MS)
    const groupsTimer = setTimeout(() => { runtime.refreshGroupNames().catch(() => {}) }, INITIAL_DELAY_MS + 2000)
    const syncTimer = setInterval(kick, 30000)
    const watchTimer = setInterval(watch, WATCH_INTERVAL_MS)
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
    if (typeof watchTimer.unref === 'function') watchTimer.unref()
    if (typeof initial.unref === 'function') initial.unref()

    return () => {
      runtime.disposed = true
      runtime.rebuild.dispose()
      clearTimeout(initial)
      clearTimeout(groupsTimer)
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
