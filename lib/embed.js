export function createEmbedder(configStore) {
  const cache = new Map()

  async function embedOne(text) {
    const cfg = configStore.get().embedding || {}
    if (!cfg.baseUrl || !cfg.model) throw new Error('embedding 未配置：缺少 baseUrl 或 model')
    const content = String(text).trim().slice(0, 4000)
    if (!content) return null
    const expectedDims = Number(cfg.dimensions) || 0
    const cacheKey = `${cfg.model}::${content}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)

    const base = String(cfg.baseUrl).replace(/\/+$/, '')
    const url = `${base}/embeddings`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 15000)
    const started = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, input: content }),
        signal: controller.signal,
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = body?.error?.message || body?.message || res.statusText
        throw new Error(`embedding 接口 ${res.status}：${msg}`)
      }
      const vec = body?.data?.[0]?.embedding
      if (!Array.isArray(vec) || vec.length === 0) throw new Error('embedding 返回为空或格式不对')
      if (expectedDims && vec.length !== expectedDims) {
        throw new Error(`维度不一致：配置 ${expectedDims} 维，接口返回 ${vec.length} 维。请检查模型名或配置里的 dimensions`)
      }
      const out = { vector: Float32Array.from(vec), dims: vec.length, ms: Date.now() - started }
      cache.set(cacheKey, out)
      if (cache.size > 2000) cache.delete(cache.keys().next().value)
      return out
    } finally {
      clearTimeout(timer)
    }
  }

  async function test() {
    const t0 = Date.now()
    const r = await embedOne('群的记忆测试：今天天气不错')
    return { ok: true, dims: r.dims, ms: Date.now() - t0 }
  }

  return { embedOne, test }
}
