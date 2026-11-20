import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { cleanText, embedQueryWithDeadline, semanticLimit } from './recall.js'
import { memoryToolDefinition } from './tool.js'

const SRC_RE = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/i
const LEADING_IM_BLOCK = /^<(dsh_im_(?:source|source_guidance|context|reply_to))>[\s\S]*?<\/\1>\s*/
const IM_RPC = /^(qq|feishu|dingtalk|weixin|wecom(?:-app)?|slack|telegram|discord|whatsapp|imessage|matrix)-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const SOURCE_KIND = 'group-vector-memory'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function createUserMessage(input) {
  return deepFreeze({ ...structuredClone(input), role: 'user', id: randomUUID() })
}

function textOfMessage(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  }
  return typeof message?.text === 'string' ? message.text : ''
}

export function parseImSource(eventOrText) {
  const text = typeof eventOrText === 'string' ? eventOrText : textOfMessage(eventOrText?.data ?? eventOrText)
  const m = SRC_RE.exec(text)
  if (!m) return null
  try {
    const meta = JSON.parse(m[1].trim())
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  } catch {
    return null
  }
}

function stringId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 上游允许在同一个会话绑定多种来源；只处理本轮原始的 IM 请求和起始包装。 */
export function findGroupMessage(messages) {
  if (!Array.isArray(messages)) return null
  let hit = null
  for (const message of messages) {
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    const rpc = IM_RPC.exec(message.source.rpcId ?? '')
    if (!rpc || message.content?.[0]?.type !== 'text') return null
    const text = textOfMessage(message)
    let remaining = text
    let meta = null
    for (let block; (block = LEADING_IM_BLOCK.exec(remaining)); remaining = remaining.slice(block[0].length)) {
      if (block[1] === 'dsh_im_source') {
        meta = parseImSource(block[0])
        if (!meta) return null
        remaining = remaining.slice(block[0].length)
        break
      }
    }
    const channel = rpc[1].toLowerCase()
    const explicitType = stringId(meta?.conversationType).toLowerCase()
    const chatId = stringId(meta?.chatId)
    if (!meta || !chatId || (meta.channel !== undefined && stringId(meta.channel) !== channel) ||
        (explicitType && explicitType !== 'group')) return null
    if (hit && (hit.channel !== channel || hit.chatId !== chatId)) return null
    hit = { meta, text, message, channel, chatId }
  }
  return hit
}

export function workspaceAllowed(cwd, workspaces) {
  const norm = p => typeof p === 'string' && p.trim() ? resolve(p.trim()) : ''
  const list = Array.isArray(workspaces) ? workspaces.map(norm).filter(Boolean) : []
  if (!list.length) return true
  const dir = norm(cwd)
  return Boolean(dir) && list.some(base => dir === base || dir.startsWith(base.endsWith(sep) ? base : `${base}${sep}`))
}

export function agentWorkspaceAllowed(agent, cfg) {
  const session = agent?.session
  const cwd = (session && agent?.ctx?.workingDirectory?.get?.(session)) ?? session?.cwd ?? agent?.cwd ?? session?.header?.cwd
  return workspaceAllowed(cwd, cfg?.workspaces)
}

export function cleanQuery(text) {
  let body = String(text || '')
  for (let block; (block = LEADING_IM_BLOCK.exec(body));) body = body.slice(block[0].length)
  return cleanText(body)
}

function archiveGroups(runtime) {
  const path = runtime.imReader?.path
  const hostPath = resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'integrations', 'dsh-im', 'group-history.sqlite')
  return typeof path === 'string' && resolve(path) === hostPath ? runtime.imReader.groups() : []
}

function groupForRoute(runtime, { channel, chatId }) {
  const groups = archiveGroups(runtime)
  const matches = groups.filter(g => g.channel === channel && g.platform_group_id === chatId)
  return matches.length === 1 ? stringId(matches[0].id) : ''
}

/** dsh-im's archive tool authorizes the current turn, not the session binding or the prompt text.
 * Its reported name (or platform ID if unnamed) is usable only if unique in the same archive.
 * Make a standard file-list request over a single instant and random keyword; require no records.
 */
async function groupAuthorized(runtime, agent, groupId, signal) {
  if (!groupId || signal?.aborted) return false
  try {
    const hostTool = (runtime.ctx ?? agent?.ctx?.root)?.tools?.get?.('dsh_im_group_history')
    if (hostTool?.name !== 'dsh_im_group_history' || typeof hostTool.execute !== 'function') return false
    const instant = new Date().toISOString()
    const result = await hostTool.execute({ kind: 'files', from: instant, to: instant, keyword: randomUUID(), limit: 1 }, { agent, signal })
    if (signal?.aborted || !Array.isArray(result?.items) || result.items.length || !stringId(result.groupName)) return false
    // This must be the archive's raw effective label, not a locally edited display name.
    const groups = archiveGroups(runtime)
    const matches = groups.filter(g => (g.name || g.platform_group_id) === result.groupName)
    return matches.length === 1 && matches[0].id === groupId
  } catch {
    return false
  }
}

function disposer(value) {
  if (typeof value === 'function') return value
  if (typeof value?.off === 'function') return () => value.off()
  return () => {}
}

export function mountAgent(agent, runtime) {
  let current = null
  let offTool = null
  let disposed = false
  const allowed = cfg => cfg?.enabled === true && agentWorkspaceAllowed(agent, cfg)
  const refresh = () => {
    if (disposed) return
    if (!allowed(runtime.configStore.get())) {
      const off = offTool
      offTool = null
      off?.()
      return
    }
    if (offTool || typeof agent?.ctx?.tools?.register !== 'function') return
    try {
      offTool = disposer(agent.ctx.tools.register(memoryToolDefinition(runtime, {
        agent,
        workspaceCheck: cfg => agentWorkspaceAllowed(agent, cfg),
        async resolveGroup(signal) {
          const scope = current
          if (!scope?.groupId || !await groupAuthorized(runtime, agent, scope.groupId, signal)) return ''
          return disposed || current !== scope ? '' : scope.groupId
        },
      })))
    } catch (e) {
      runtime.log?.(`[gvm] 注册查询工具失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  refresh()

  const offStep = disposer(agent.ctx.on('agent/pre-step', async (payload, next) => {
    const { turn, messages, signal } = payload
    let memoryMessage
    try {
      if (current?.turn !== turn) current = { turn, groupId: '' }
      refresh()
      const cfg = runtime.configStore.get()
      const hit = findGroupMessage(messages)
      if (hit || messages?.some(m => m?.source?.kind === 'user')) current = { turn, groupId: '' }
      if (hit && allowed(cfg) && !signal?.aborted) {
        const groupId = groupForRoute(runtime, hit)
        if (await groupAuthorized(runtime, agent, groupId, signal) && !disposed && allowed(runtime.configStore.get())) {
          current.groupId = groupId
          const senderId = stringId(hit.meta.senderId)
          if (senderId && runtime.configStore.get().inject?.enabled) {
            const query = cleanQuery(hit.text)
            const vec = semanticLimit(cfg) > 0
              ? await embedQueryWithDeadline(runtime.embedOne?.bind(runtime), query, { signal })
              : null
            const live = runtime.configStore.get()
            if (!disposed && !signal?.aborted && allowed(live) && live.inject?.enabled) {
              const { recent, semantic, literal = [] } = runtime.recall(senderId, query, semanticLimit(live) > 0 ? vec?.vector ?? null : null, groupId)
              if (recent.length || semantic.length || literal.length) {
                const block = runtime.format({ senderName: stringId(hit.meta.senderName), userId: senderId, recent, semantic, literal })
                memoryMessage = createUserMessage({
                  // dsh-im rechecks persisted messages by request ID; keep this snapshot attached to the authorized request.
                  source: { kind: SOURCE_KIND, rpcId: hit.message.source.rpcId, form: 'snapshot', sections: [{ name: 'group-vector-context', text: block }] },
                  content: [{ type: 'text', text: block }],
                })
              }
            }
          }
        }
      }
    } catch (e) {
      runtime.log?.(`[gvm-inject] 失败（放行）: ${e instanceof Error ? e.message : String(e)}`)
    }
    const base = await next()
    if (!memoryMessage || base?.kind === 'reject' || disposed || signal?.aborted) return base
    const live = runtime.configStore.get()
    if (!allowed(live) || !live.inject?.enabled) return base
    return { ...(base || { kind: 'enter' }), messages: [...(base?.messages || messages || []), memoryMessage] }
  }))

  const off = () => {
    disposed = true
    current = null
    try { offTool?.() } finally { offStep() }
  }
  off.refresh = refresh
  return off
}

export function installInjector(ctx, runtime) {
  const mounted = new Map()
  const sweep = () => {
    try {
      const list = ctx.agents?.list?.() ?? []
      const arr = Array.isArray(list) ? list : (typeof list.values === 'function' ? [...list.values()] : [])
      const seen = new Set()
      for (const agent of arr) {
        const sid = String(agent?.session?.id || agent?.sessionId || agent?.id || '')
        if (!sid) continue
        seen.add(sid)
        const prev = mounted.get(sid)
        if (prev?.agent === agent) {
          prev.off.refresh()
          continue
        }
        if (prev) { prev.off(); mounted.delete(sid) }
        try {
          mounted.set(sid, { agent, off: mountAgent(agent, runtime) })
        } catch (e) {
          runtime.log?.(`[gvm] 挂载失败: ${e.message}`)
        }
      }
      for (const [sid, { off }] of mounted) {
        if (seen.has(sid)) continue
        try { off() } finally { mounted.delete(sid) }
      }
    } catch (e) {
      runtime.log?.(`[gvm] 遍历 agents 失败: ${e.message}`)
    }
  }

  runtime.refreshAgentScopes = sweep
  sweep()
  const timer = setInterval(sweep, 10000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (runtime.refreshAgentScopes === sweep) delete runtime.refreshAgentScopes
    for (const { off } of mounted.values()) { try { off() } catch {} }
    mounted.clear()
  }
}
