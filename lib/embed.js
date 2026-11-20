import { createHash } from 'node:crypto'

function embeddingConfig(config) {
  const cfg = config.embedding || {}
  return {
    base: String(cfg.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/embeddings$/, ''),
    model: String(cfg.model || '').trim(),
    dims: Number(cfg.dimensions) || 0,
    apiKey: String(cfg.apiKey || ''),
    timeout: Number(cfg.timeoutMs) || 15000,
  }
}

const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export function embeddingSpace(config) {
  const { base, model, dims } = embeddingConfig(config)
  return hash([base, model, dims])
}

export function createEmbedder(configStore) {
  const cache = new Map()
  const inFlight = new Map()

  async function request(cfg, content, signal) {
    const { base, model, dims: expectedDims, apiKey, timeout } = cfg
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const started = Date.now()
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: content }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = body?.error?.message || body?.message || res.statusText
        throw new Error(`embedding 接口 ${res.status}：${msg}`)
      }
      const vec = body?.data?.[0]?.embedding
      if (!Array.isArray(vec) || vec.length === 0 || !vec.every(Number.isFinite)) {
        throw new Error('embedding 返回为空或格式不对')
      }
      if (expectedDims && vec.length !== expectedDims) {
        throw new Error(`维度不一致：配置 ${expectedDims} 维，接口返回 ${vec.length} 维。请检查模型名或配置里的 dimensions`)
      }
      return { vector: Float32Array.from(vec), dims: vec.length, ms: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }

  async function embedOne(text, { fresh = false, config = configStore.get(), signal } = {}) {
    signal?.throwIfAborted()
    const cfg = embeddingConfig(config)
    if (!cfg.base || !cfg.model) throw new Error('embedding 未配置：缺少 baseUrl 或 model')
    const content = String(text).trim().slice(0, 4000)
    if (!content) return null
    if (fresh) return request(cfg, content, signal)

    const cacheKey = `${hash([cfg.base, cfg.model, cfg.dims, cfg.apiKey])}:${content}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)
    const remember = result => {
      cache.set(cacheKey, result)
      if (cache.size > 2000) cache.delete(cache.keys().next().value)
      return result
    }
    // 带期限的前台查询不能取消后台共享的请求。
    if (signal) return request(cfg, content, signal).then(remember)
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey)
    const pending = request(cfg, content).then(remember).finally(() => inFlight.delete(cacheKey))
    inFlight.set(cacheKey, pending)
    return pending
  }

  async function test() {
    const t0 = Date.now()
    const r = await embedOne('群的记忆测试：今天天气不错', { fresh: true })
    return { ok: true, dims: r.dims, ms: Date.now() - t0 }
  }

  return { embedOne, test }
}
