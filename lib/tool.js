import { extractKeywords, cleanText, embedQueryWithDeadline, rankSemantic, semanticLimit } from './recall.js'

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0)
  if (Number.isNaN(d.getTime())) return '?'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 群的展示名：有名字用名字，有群号带群号，都没有就退到 openid 前 8 位。 */
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
  const label = id ? groupLabel(groups.get(id), id) : ''
  const g = label ? `[${label}]` : ''
  return `- ${fmtTime(m.sentAt)}${g} ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`
}

export function memoryToolDefinition(runtime, { trusted = false, agent, resolveGroup, workspaceCheck } = {}) {
  const { store, configStore } = runtime
  const denied = text => ({ found: 0, text })
  const unavailable = () => denied('无法确认当前请求所属的群，未执行查询。')
  const disabled = () => denied('当前会话未启用群记忆查询。')
  const enabled = cfg => cfg?.enabled === true && (workspaceCheck?.(cfg) ?? trusted)

  return {
    name: 'group_memory_lookup',
    description: (trusted ? '查某个群友在指定群或归档中说过的话。' : '只查询本轮请求所在群里的发言（按人查）。') +
      '只填 person 就返回他最近的发言；再给 query 就按关键词/语义相关度找。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        person: { type: 'string', description: '群友的名字或 ID，名字可以只写一部分' },
        query: { type: 'string', description: '可选：关键词或想问的事；不填则按时间返回最近发言' },
        ...(trusted ? { groupId: { type: 'string', description: '可选：归档群 ID；不填则跨群查询' } } : {}),
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
        return [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : '（没有结果）' }]
      },
    },
    async execute(args, exec) {
      let cfg = configStore.get()
      if (!enabled(cfg)) return disabled()
      const signal = exec?.signal
      if (signal?.aborted) return unavailable()
      let groupId
      if (trusted && !exec?.agent) {
        if (Object.hasOwn(args, 'groupId')) {
          groupId = typeof args.groupId === 'string' ? args.groupId.trim() : ''
          if (!groupId) return unavailable()
        }
      } else {
        if (!agent || exec?.agent !== agent || Object.hasOwn(args, 'groupId')) return unavailable()
        groupId = await resolveGroup?.(signal)
        if (!groupId || signal?.aborted) return unavailable()
        cfg = configStore.get()
        if (!enabled(cfg)) return disabled()
      }

      const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit) || 8)))
      const person = String(args.person || '').trim()
      const needle = person.toLowerCase()
      const query = cleanText(args.query)
      const members = store.members(groupId)
      const picked = needle && (members.find(m => String(m.senderId) === person) ?? members.find(m =>
        String(m.senderName || '').toLowerCase().includes(needle) ||
        String(m.senderId || '').toLowerCase().includes(needle)))
      if (!picked) {
        const names = [...new Set(members.map(m => m.senderName).filter(Boolean))].slice(0, 20).join('、')
        return denied(`没找到「${person}」。${groupId ? '当前群' : '归档'}里有：${names || '（还没有任何人）'}`)
      }

      let rows = []
      let mode = '最近'
      if (query) {
        const kws = extractKeywords(query)
        const literal = kws.length ? store.searchByKeywords(picked.senderId, kws, limit * 2, 1, groupId) : []
        let semantic = []
        if (semanticLimit(cfg) > 0) {
          const embedOne = runtime.embedOne?.bind(runtime) ?? runtime.embedder?.embedOne?.bind(runtime.embedder)
          const embedded = await embedQueryWithDeadline(embedOne, query, { signal })
          cfg = configStore.get()
          if (!enabled(cfg)) return disabled()
          if (signal?.aborted) return unavailable()
          // 权限在等待期间可能因换轮或退订消失；不返回等待前缓存的结果。
          if (groupId && resolveGroup && groupId !== await resolveGroup(signal)) return unavailable()
          cfg = configStore.get()
          if (!enabled(cfg)) return disabled()
          if (signal?.aborted) return unavailable()
          const semanticN = Math.min(limit * 2, semanticLimit(cfg))
          if (semanticN > 0) {
            semantic = rankSemantic(store.vectorsBySender(picked.senderId, 2000, groupId), query, embedded?.vector, {
              limit: semanticN, minScore: Number(cfg.recall?.minScore ?? 0.25),
            })
          }
        }
        const seen = new Set()
        for (const r of [...semantic, ...literal]) {
          const key = r.id ?? `${r.groupId}:${r.sentAt}:${r.text}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push(r)
          if (rows.length >= limit) break
        }
        mode = `关于「${query}」`
      }

      if (!rows.length) {
        rows = store.messagesOf(picked.senderId, groupId, limit, 0)
        mode = '最近'
      }
      const header = `${picked.senderName || picked.senderId}（共 ${picked.count} 条记录）`
      if (!rows.length) return denied(`${header}，但一条记录都没有。`)

      const groups = new Map((store.groupInfo() ?? []).filter(g => !groupId || g.groupId === groupId).map(g => [g.groupId, g]))
      const body = rows.map(r => line(r, groups)).join('\n')
      return { found: rows.length, text: `${header} ${mode} ${rows.length} 条：\n${body}` }
    },
  }
}

/** 保留供同进程可信调用者显式注册；带 agent 的执行仍需验证自身群域。 */
export function registerMemoryTool(ctx, runtime, options) {
  return ctx.tools.register(memoryToolDefinition(runtime, options))
}
