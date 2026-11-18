import { cosine } from './store.js'

/**
 * 同步召回：热门路径用这个。
 * 语义查询不实时打 embedding 接口——直接用「当前消息是否已入库向量化」，
 * 已入库就用它的向量，没入库就只给短期召回。这样注入永远在 followup 之前完成，
 * 不会因为网络延迟错过时机。
 */
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

export function recallSync({ store, senderId, query, queryVec, cfg }) {
  const recentN = Math.max(0, Number(cfg?.recall?.recent ?? 10))
  const semanticN = Math.max(0, Number(cfg?.recall?.semantic ?? 8))
  const minScore = Number(cfg?.recall?.minScore ?? 0.25)

  const recent = recentN > 0 ? store.recentBySender(senderId, recentN) : []
  const recentTexts = new Set(recent.map(r => String(r.text).trim()))
  const q = String(query || '').trim()

  // 字面召回：不需要向量，这一轮立即就能用
  let literal = []
  try {
    const kws = extractKeywords(q)
    if (kws.length) literal = store.searchByKeywords(senderId, kws, 6)
  } catch {}

  let semantic = []
  if (semanticN > 0) {
    const rows = store.vectorsBySender(senderId, 2000)
    // 优先用调用方刚算好的当前消息向量；没有就退回库里最后一条已向量化的消息
    // 只认「当前这条消息」的向量：调用方给的就用，或者库里正好有同文本的。
    // 都没有就这轮不做语义召回——绝不拿上一条旧消息的向量冒充，那样召回出来的是错的。
    const vec = queryVec || (q ? rows.find(r => cleanText(r.text) === q)?.vector : undefined)
    if (vec) {
      const scored = []
      for (const r of rows) {
        if (recentTexts.has(String(r.text).trim())) continue
        const score = cosine(vec, r.vector)
        if (score >= minScore) scored.push({ text: r.text, sentAt: r.sent_at, score })
      }
      scored.sort((a, b) => b.score - a.score)
      semantic = scored.slice(0, semanticN)
    }
  }
  return { recent, semantic, literal }
}

/** 异步召回：设置页「预览召回」用，允许实时打 embedding 接口。 */
export async function recallAsync({ store, embedder, senderId, query, cfg }) {
  const base = recallSync({ store, senderId, query, cfg })
  if (base.semantic.length > 0) return base
  const semanticN = Math.max(0, Number(cfg?.recall?.semantic ?? 8))
  const minScore = Number(cfg?.recall?.minScore ?? 0.25)
  const q = String(query || '').trim()
  if (!q || semanticN === 0) return base
  try {
    const vec = await embedder.embedOne(q)
    if (!vec?.vector) return base
    const rows = store.vectorsBySender(senderId, 2000)
    const recentTexts = new Set(base.recent.map(r => String(r.text).trim()))
    const scored = []
    for (const r of rows) {
      if (recentTexts.has(String(r.text).trim())) continue
      const score = cosine(vec.vector, r.vector)
      if (score >= minScore) scored.push({ text: r.text, sentAt: r.sent_at, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return { recent: base.recent, semantic: scored.slice(0, semanticN) }
  } catch {
    return base
  }
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
