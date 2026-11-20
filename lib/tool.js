/**
 * 群记忆查询工具 —— 给模型主动翻群友发言用。
 *
 * 跟自动注入（pre-step）是两条路：
 *   自动注入：这一轮谁在说话，就塞他自己最近说的 + 相关历史，模型被迫看到。
 *   这个工具：模型自己想查谁就查谁——召回没带出来的、想回头核对的，都能翻。
 *
 * 按人查，不是把群里所有人最近聊的糊成一坨。
 */

import { cosine } from './store.js'
import { extractKeywords, cleanText } from './recall.js'

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0)
  if (Number.isNaN(d.getTime())) return '?'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 按名字或 ID 找人（名字可只写一部分） */
function findPeople(store, person) {
  const needle = String(person || '').trim().toLowerCase()
  if (!needle) return []
  const all = store.members()
  const exact = all.filter(m => String(m.senderId) === String(person))
  if (exact.length) return exact
  return all.filter(m =>
    String(m.senderName || '').toLowerCase().includes(needle) ||
    String(m.senderId || '').toLowerCase().includes(needle),
  )
}

/** 把一条消息格式化成一行 */
/** 群的展示名：有名字用名字，有群号带群号，都没有就退到 openid 前 8 位 */
function groupLabel(info, fallbackId) {
  if (!info) return fallbackId ? String(fallbackId).slice(0, 8) : ''
  const name = info.name || info.autoName || ''
  if (name && info.qqNumber) return `${name}·${info.qqNumber}`
  if (name) return name
  if (info.qqNumber) return `QQ群·${info.qqNumber}`
  return info.platformGroupId ? String(info.platformGroupId).slice(0, 8) : String(fallbackId || '').slice(0, 8)
}

function line(m, groups) {
  const id = m.groupId ? String(m.groupId) : ''
  const label = id ? groupLabel(groups?.get(id), id) : ''
  const g = label ? `[${label}]` : ''
  return `- ${fmtTime(m.sentAt)}${g} ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`
}

/** 只产出 definition，注册交给调用方（全局 ctx 或 agent.ctx） */
export function memoryToolDefinition(runtime) {
  const { store, configStore, embedder } = runtime

  return {
    name: 'group_memory_lookup',
    description:
      '查某个群友在群里说过的话（按人查，不是查整个群）。' +
      '只填 person 就返回他最近的发言；再给 query 就按关键词/语义相关度找。' +
      '自动召回没带出来的旧话，用这个主动翻。',
    parameters: {
      type: 'object',
      properties: {
        person: { type: 'string', description: '群友的名字或 ID，名字可以只写一部分（如「王阿牛」）' },
        query: { type: 'string', description: '可选：关键词或想问的事，给了就按相关度找，不给就按时间取最近几条' },
        groupId: { type: 'string', description: '可选：只查某个群；不填就跨群查这个人' },
        limit: { type: 'number', description: '可选：最多返回几条，默认 8，上限 30' },
      },
      required: ['person'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'number', description: '匹配到的消息条数' },
          text: { type: 'string', description: '给模型看的文本' },
        },
        required: ['found', 'text'],
      },
      render(_args, value) {
        // dsh 要求 render 返回内容块数组；返回字符串会对它调 content.some(...)，
        // 抛 `content.some is not a function`（2026-11-20 查到的原因）。
        return [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : '（没有结果）' }]
      },
    },
    async execute(args) {
      const cfg = configStore.get()
      if (!cfg.enabled) return { found: 0, text: '群记忆插件现在是关着的（设置页可以打开）。' }

      const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit) || 8)))
      const groupId = args.groupId ? String(args.groupId) : ''
      const person = String(args.person || '').trim()
      const query = String(args.query || '').trim()

      const people = findPeople(store, person)
      if (!people.length) {
        const all = store.members()
        const names = [...new Set(all.map(m => m.senderName).filter(Boolean))].slice(0, 20).join('、')
        return { found: 0, text: `没找到「${person}」。目前库里有：${names || '（还没有任何人）'}` }
      }

      const groups = new Map((store.groupInfo() || []).map(g => [g.groupId, g]))
      const picked = people[0]
      const header = `${picked.senderName || picked.senderId}（共 ${picked.count} 条记录）`

      let rows = []
      let mode = '最近'

      if (query) {
        // 关键词召回（本地、快）
        const kws = extractKeywords(cleanText(query))
        const literal = kws.length ? store.searchByKeywords(picked.senderId, kws, limit * 2, 1) : []
        // 语义召回（要给 query 算向量）
        let semantic = []
        try {
          const embedded = await embedder.embedOne(cleanText(query))
          if (embedded?.vector) {
            const vecs = store.vectorsBySender(picked.senderId, 2000)
            semantic = vecs
              .map(v => ({ ...v, score: cosine(embedded.vector, v.vector) }))
              .filter(v => v.score >= (cfg.recall?.minScore ?? 0.25))
              .sort((a, b) => b.score - a.score)
              .slice(0, limit * 2)
          }
        } catch {}
        // 合并去重：语义优先，关键词补位
        const seen = new Set()
        for (const r of [...semantic, ...literal]) {
          const key = r.id ?? `${r.sentAt}:${r.text}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push(r)
          if (rows.length >= limit) break
        }
        mode = `关于「${query}」`
      }

      if (!rows.length) {
        rows = store.messagesOf(picked.senderId, groupId || undefined, limit, 0)
        mode = groupId ? `最近（群 ${groupId}）` : '最近'
      }

      if (!rows.length) return { found: 0, text: `${header}，但一条记录都没有。` }

      const body = rows.map(r => line(r, groups)).join('\n')
      return {
        found: rows.length,
        text: `${header} ${mode} ${rows.length} 条：\n${body}`,
      }
    },
  }
}

/** 全局注册（旧入口，保留兼容） */
export function registerMemoryTool(ctx, runtime) {
  return ctx.tools.register(memoryToolDefinition(runtime))
}

