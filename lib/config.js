import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_CONFIG = {
  enabled: true,
  // 调试日志：默认关。只有排查问题时才在设置页打开，平时别刷日志。
  debug: false,
  embedding: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
    timeoutMs: 15000,
  },
  recall: {
    recent: 10,
    semantic: 8,
    minScore: 0.25,
  },
  inject: {
    enabled: true,
    maxChars: 2000,
  },
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function createConfigStore(dataDir) {
  const dir = dataDir || '.'
  const file = join(dir, 'config.json')
  mkdirSync(dir, { recursive: true })

  let current = structuredClone(DEFAULT_CONFIG)
  if (existsSync(file)) {
    try {
      current = deepMerge(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')))
    } catch {}
  }

  return {
    file,
    get: () => structuredClone(current),
    update(patch) {
      current = deepMerge(current, patch || {})
      writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 })
      return structuredClone(current)
    },
    publicView() {
      const c = structuredClone(current)
      if (!c.embedding || typeof c.embedding !== 'object') c.embedding = structuredClone(DEFAULT_CONFIG.embedding)
      const rawKey = c.embedding.apiKey || ''
      if (rawKey) c.embedding.apiKeyMasked = '••••' + rawKey.slice(-4)
      c.embedding.apiKeySet = Boolean(rawKey)
      delete c.embedding.apiKey          // 绝不把明文密钥返回前端
      if (!c.recall || typeof c.recall !== 'object') c.recall = structuredClone(DEFAULT_CONFIG.recall)
      if (!c.inject || typeof c.inject !== 'object') c.inject = structuredClone(DEFAULT_CONFIG.inject)
      return c
    },
  }
}
