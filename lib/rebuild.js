import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export function createEmbeddingRebuild({ readConfig, canEmbed, refreshSpace, store, embedBatch, batchSize, waitForSync }) {
  let target = ''
  let signature
  let active = null
  let last = { state: 'idle' }
  let disposed = false

  function observe() {
    const cfg = readConfig()
    const next = JSON.stringify([cfg.enabled, cfg.embedding])
    if (next !== signature) {
      signature = next
      target = randomUUID()
      if (active && !active.controller.signal.aborted) {
        last = { state: 'stopped', error: '向量配置已变化，重建已停止。' }
        active.controller.abort()
      } else {
        last = { state: 'idle' }
      }
    }
    return cfg
  }

  function status() {
    const cfg = observe()
    refreshSpace(cfg)
    const { total, embedded } = store.embeddingCounts()
    const available = canEmbed(cfg)
    let result = last
    if (active?.target === target) result = { state: 'running' }
    else if (available && total === embedded && last.state === 'paused') result = { state: 'done' }
    else if (total !== embedded && last.state === 'done') result = { state: 'idle' }
    return { ...result, available, total, embedded, model: String(cfg.embedding?.model || '').trim(), target }
  }

  function start(expected) {
    const current = status()
    if (expected !== current.target) throw new Error('向量配置已变化，请核对后重新确认。')
    if (!current.available || disposed) throw new Error('请先启用并保存向量模型配置。')
    if (active?.target === target) return current
    if (active) throw new Error('之前的重建正在停止，请稍后重试。')
    if (current.total === current.embedded) {
      last = { state: 'done' }
      return status()
    }

    const cfg = observe()
    const job = { target, controller: new AbortController() }
    active = job
    const signal = job.controller.signal
    const configForRow = () => {
      observe()
      return !disposed && !signal.aborted && target === job.target ? cfg : null
    }
    const space = refreshSpace(cfg)
    void (async () => {
      try {
        // Release the start RPC before running work, and let any existing sync batch finish.
        await setImmediate()
        await waitForSync()?.catch(() => {})
        let after = null
        while (configForRow()) {
          const rows = store.pendingEmbeddings(batchSize, after)
          if (!rows.length) break
          const { interrupted } = await embedBatch(rows, { space, configForRow, signal })
          if (!configForRow()) return
          if (interrupted) break
          after = rows.at(-1)
          await setImmediate()
        }
        if (!configForRow()) return
        const { total, embedded } = store.embeddingCounts()
        last = total === embedded ? { state: 'done' } : {
          state: 'paused', error: '还有记录未完成。请检查向量服务或稍后继续重建。',
        }
      } catch {
        if (configForRow()) last = { state: 'paused', error: '重建暂停，请检查向量服务后重试。' }
      } finally {
        if (active === job) active = null
      }
    })()
    return { ...current, state: 'running', error: undefined }
  }

  return {
    status, start, configChanged: observe,
    get running() { return active !== null },
    dispose() { disposed = true; active?.controller.abort() },
  }
}
