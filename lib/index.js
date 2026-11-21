import { createConfigStore } from './config.js'
import { createEmbedder, embeddingSpace } from './embed.js'
import { createStore } from './store.js'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { compareArrival, createImReader, defaultImPath } from './dshim.js'
import { createQqInfoReader, defaultQqChatPath } from './qqinfo.js'
import { createRpc } from './rpc.js'
import { createEmbeddingRebuild } from './rebuild.js'
import { installInjector } from './inject.js'
import { formatMemoryBlock, recallSync } from './recall.js'

export const name = 'dsh-group-vector-memory'
export const inject = ['connection', 'systemPrompt', 'agents', 'tools', 'workspaceRegistry', 'workingDirectory']

const QQ_GROUP_REPLIED = 'dsh-im/qq-group-replied'
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

  const runtime = { ctx, config, dataDir, configStore, embedder, store, imReader, qqInfo, workingDirectory: ctx.workingDirectory, syncing: null }

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

  async function copyFromIm(readCursor, write, through) {
    let copied = 0
    do {
      if (runtime.disposed || !configStore.get().enabled) break
      const cursor = readCursor()
      if (through !== undefined && compareArrival(cursor, through) >= 0) break
      const page = imReader.sinceArrival(cursor, BATCH_LIMIT)
      const rows = through === undefined ? page : page.filter(row => compareArrival(row.sourceSeq, through) <= 0)
      if (!rows.length) break
      copied += write(rows)
      if (rows.length < BATCH_LIMIT || through === undefined) break
      await yieldToLoop()
    } while (true)
    return copied
  }

  runtime.syncOnce = async function syncOnce({ drain = false } = {}) {
    if (runtime.syncing) return runtime.syncing
    runtime.syncing = (async () => {
      if (runtime.disposed || !configStore.get().enabled) return { added: 0, embedded: 0, skipped: '插件已禁用' }
      let added = 0
      let archived = 0
      if (imReader.available()) {
        const through = drain ? imReader.latestArrival() : undefined
        store.upsertGroups(imReader.groups())
        // The archive has its own cursor so retained history can be copied without re-importing memories.
        added = await copyFromIm(store.getSyncCursor, rows => store.upsertMessages(rows, rows.at(-1).sourceSeq), through)
        archived = await copyFromIm(store.archive.cursor, rows => store.archive.copy(rows), through)
      }
      if (runtime.disposed) return { added, archived, embedded: 0 }
      const cfg = configStore.get()
      const space = runtime.refreshEmbeddingSpace(cfg)
      if (!canEmbed(cfg)) return { added, archived, embedded: 0, skipped: '向量化未启用或未配置' }
      if (runtime.rebuild.running) return { added, archived, embedded: 0, skipped: '正在后台重建向量' }
      const configForRow = () => runtime.disposed ? null : configStore.get()
      let embedded = 0
      let failed = 0
      let embedError
      let after = null
      while (!runtime.disposed && !runtime.rebuild.running) {
        const rows = store.pendingEmbeddings(EMBED_BATCH, after)
        if (!rows.length) break
        const batch = await embedBatch(rows, { space, configForRow, signal: syncAbort.signal })
        embedded += batch.embedded
        failed += batch.failed
        embedError = batch.embedError ?? embedError
        if (!drain || batch.interrupted || rows.length < EMBED_BATCH) break
        after = rows.at(-1)
        await yieldToLoop()
      }
      return { added, archived, embedded, failed, ...(embedError ? { embedError } : {}) }
    })().finally(() => { runtime.syncing = null })
    return runtime.syncing
  }

  const syncAbort = new AbortController()
  let replyPending = false
  let replySync = null
  function syncAfterReply() {
    replyPending = true
    replySync ??= Promise.resolve().then(async () => {
      try {
        while (replyPending && !runtime.disposed) {
          replyPending = false
          await runtime.syncing?.catch(() => {})
          if (runtime.disposed) break
          try {
            await runtime.syncOnce({ drain: true })
          } catch (error) {
            runtime.log(`[gvm] 回复后同步失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } finally {
        replySync = null
      }
    })
    return replySync
  }
  const offReply = ctx.on?.(QQ_GROUP_REPLIED, syncAfterReply, { global: true })

  // ---- 资源注册：全部挂到 ctx.effect，热重载时自动清理 ----
  // 事件监听必须直接挂在 apply 的 ctx 上（放进 effect 回调里会挂不上）
  const offInjector = installInjector(ctx, runtime)
  // 查询工具不在这里全局注册 —— mountAgent 里按工作区、注册到 agent scope

  ctx.effect(() => {
    ctx.connection.rpc.handle('/gvm', createRpc(runtime))

    const groupsTimer = setTimeout(() => { runtime.refreshGroupNames().catch(() => {}) }, 5000)
    groupsTimer.unref?.()

    return () => {
      runtime.disposed = true
      syncAbort.abort()
      runtime.rebuild.dispose()
      clearTimeout(groupsTimer)
      if (typeof offReply === 'function') offReply()
      if (typeof offInjector === 'function') offInjector()
      try { store.close() } catch {}
      try { imReader.close() } catch {}
    }
  }, 'dsh-group-vector-memory: resources')

  console.log(`[gvm] ready: ${dataDir}`)
  return runtime
}
