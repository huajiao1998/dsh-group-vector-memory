import { cosine } from './store.js'

const QUERY_EMBED_DEADLINE_MS = 500

export function semanticLimit(cfg) {
  return Math.max(0, Number(cfg?.recall?.semantic ?? 8))
}

/** Bound interactive waits even when the embedder does not cooperate with abort. */
export async function embedQueryWithDeadline(embedOne, query, { signal } = {}) {
  if (!query || typeof embedOne !== 'function' || signal?.aborted) return null
  const controller = new AbortController()
  let timer
  let onAbort
  try {
    const stopped = new Promise(resolve => {
      onAbort = () => {
        controller.abort()
        resolve(null)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(onAbort, QUERY_EMBED_DEADLINE_MS)
      timer.unref?.()
    })
    return await Promise.race([
      stopped,
      Promise.resolve().then(() => embedOne(query, { signal: controller.signal })).catch(() => null),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** 清掉 QQ/飞书的内部 @ 标记（<@ID> / @_user_N），模型看了没用 */
export function cleanText(text) {
  return String(text || '')
    .replace(/<@[^>]{1,80}>/g, '@某人')
    .replace(/@_user_\d+/g, '@某人')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从一句话里抽关键词（纯本地、同步、毫秒级）。
 * 中文用 3-4 字片段为主（2 字太碎，召回全是噪声），英文按单词。
 */
export function extractKeywords(text) {
  const s = String(text || '')
    .replace(/<@[^>]{1,80}>/g, ' ')
    .replace(/@某人/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
  const stop = new Set(['这个','那个','什么','怎么','就是','不是','可以','没有','我们','你们','他们','一个','现在','时候','已经','还是','因为','所以','但是','如果','真的','知道','觉得','应该','可能','然后','这样','那样','一下','不是','么样'])
  const out = new Set()
  for (const w of s.split(/\s+/)) {
    if (!w) continue
    if (/^[A-Za-z0-9_]+$/.test(w)) { if (w.length >= 2) out.add(w); continue }
    const len = w.length
    if (len < 2) continue
    // 整句短就当整体
    if (len <= 6) out.add(w)
    // 3-4 字片段（覆盖大部分有意义的词）
    for (let n = 3; n <= 4; n += 1) {
      for (let i = 0; i + n <= len; i += 1) {
        const piece = w.slice(i, i + n)
        if (!stop.has(piece)) out.add(piece)
      }
    }
  }
  return [...out].slice(0, 16)
}

export function rankSemantic(rows, query, queryVec, { limit, minScore, excluded = new Set() }) {
  const vec = queryVec || (query ? rows.find(r => cleanText(r.text) === query)?.vector : undefined)
  if (!vec) return []
  return rows
    .filter(r => !excluded.has(String(r.text).trim()))
    .map(r => ({ id: r.id, text: r.text, sentAt: r.sentAt ?? r.sent_at, groupId: r.groupId ?? r.group_id, score: cosine(vec, r.vector) }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// 省略 groupId 的宽域入口只留给明确选择该范围的可信调用者。
export function recallSync({ store, senderId, query, queryVec, cfg, groupId }) {
  if (groupId !== undefined && (typeof groupId !== 'string' || !groupId.trim())) {
    return { recent: [], semantic: [], literal: [] }
  }
  const recentN = Math.max(0, Number(cfg?.recall?.recent ?? 10))
  const semanticN = semanticLimit(cfg)
  const minScore = Number(cfg?.recall?.minScore ?? 0.25)
  const recent = recentN > 0 ? store.recentBySender(senderId, recentN, groupId) : []
  const q = cleanText(query)

  let literal = []
  try {
    const kws = extractKeywords(q)
    if (kws.length) literal = store.searchByKeywords(senderId, kws, 6, 1, groupId)
  } catch {}

  const semantic = semanticN > 0 && (q || queryVec)
    ? rankSemantic(store.vectorsBySender(senderId, 2000, groupId), q, queryVec, {
      limit: semanticN, minScore, excluded: new Set(recent.map(r => String(r.text).trim())),
    })
    : []
  return { recent, semantic, literal }
}

/** 设置页预览可补算语义向量，但超时或失败时原样返回本地召回。 */
export async function recallAsync({ store, embedder, senderId, query, cfg, groupId, signal }) {
  const base = recallSync({ store, senderId, query, cfg, groupId })
  const limit = semanticLimit(cfg)
  const q = cleanText(query)
  if (!q || !(limit > 0) || base.semantic.length || signal?.aborted ||
      (groupId !== undefined && (typeof groupId !== 'string' || !groupId.trim()))) return base
  const embedded = await embedQueryWithDeadline(embedder?.embedOne?.bind(embedder), q, { signal })
  if (!embedded?.vector) return base
  const semantic = rankSemantic(store.vectorsBySender(senderId, 2000, groupId), q, embedded.vector, {
    limit, minScore: Number(cfg?.recall?.minScore ?? 0.25),
    excluded: new Set(base.recent.map(r => String(r.text).trim())),
  })
  return { ...base, semantic }
}

export function formatMemoryBlock({ senderName, userId, recent, semantic, literal = [], maxChars = 2000 }) {
  const who = senderName || userId
  const lines = []
  lines.push(`【群里这个人：${who}（ID ${userId}）】`)
  if (recent.length) {
    lines.push('最近说过的：')
    for (const r of [...recent].reverse()) lines.push(`- ${cleanText(r.text).slice(0, 120)}`)
  }
  if (!semantic.length && literal.length) {
    lines.push('以前说到过的：')
    for (const r of literal) lines.push(`- ${cleanText(r.text).slice(0, 120)}`)
  } else if (semantic.length) {
    lines.push('以前相关的：')
    for (const r of semantic) lines.push(`- ${cleanText(r.text).slice(0, 120)}`)
  }
  let out = lines.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…'
  return out
}
