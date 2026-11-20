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

function isSourceNotice(message) {
  return message?.role === 'user' && message.source?.kind === 'plugin:dsh-im' &&
    message.source.form === 'notice' && textOfMessage(message).startsWith('<dsh_im_source>')
}

/** dsh-im places a split source notice immediately after its request. */
export function findGroupMessage(messages) {
  if (!Array.isArray(messages)) return null
  let hit = null
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isSourceNotice(message)) return null
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
        break
      }
    }
    const channel = rpc[1].toLowerCase()
    const notice = messages[i + 1]
    const split = isSourceNotice(notice)
    if (split) {
      if (meta || notice.content?.length !== 1) return null
      const envelope = textOfMessage(notice)
      const block = LEADING_IM_BLOCK.exec(envelope)
      if (!block || block[0].length !== envelope.length) return null
      meta = parseImSource(envelope)
      i++
    }
    const explicitType = stringId(meta?.conversationType).toLowerCase()
    const chatId = stringId(meta?.chatId)
    if (!meta || !chatId || (meta.channel !== undefined && stringId(meta.channel) !== channel) ||
        ((split || explicitType) && explicitType !== 'group')) return null
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

export function agentWorkspaceAllowed(agent, cfg, workingDirectory) {
  const session = agent?.session
  const cwd = (session && workingDirectory?.get?.(session)) ?? session?.cwd ?? agent?.cwd ?? session?.header?.cwd
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
  const workspaceCheck = cfg => agentWorkspaceAllowed(agent, cfg, runtime.workingDirectory)
  const allowed = cfg => cfg?.enabled === true && workspaceCheck(cfg)
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
        workspaceCheck,
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
      if (hit || messages?.some(m => m?.source?.kind === 'user' || isSourceNotice(m))) current = { turn, groupId: '' }
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
        } else if (!disposed && !signal?.aborted) {
          runtime.log?.('[gvm-inject] skipped: group authorization unavailable')
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
  const sessionId = agent => String(agent?.session?.id || agent?.sessionId || agent?.id || '')
  const mount = agent => {
    const sid = sessionId(agent)
    if (!sid) return
    const prev = mounted.get(sid)
    try {
      if (prev?.agent === agent) return prev.off.refresh()
      if (prev) { prev.off(); mounted.delete(sid) }
      mounted.set(sid, { agent, off: mountAgent(agent, runtime) })
    } catch (e) {
      runtime.log?.(`[gvm] 挂载失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const offCreated = disposer(ctx.on?.('agent/created', ({ agent }) => { mount(agent) }, { global: true }))
  const offDisposed = disposer(ctx.on?.('agent/disposed', ({ agent }) => {
    const sid = sessionId(agent)
    const entry = mounted.get(sid)
    if (entry && entry.agent === agent) { mounted.delete(sid); entry.off() }
  }, { global: true }))
  const sweep = () => {
    try {
      const list = ctx.agents?.list?.() ?? []
      const arr = Array.isArray(list) ? list : (typeof list.values === 'function' ? [...list.values()] : [])
      const seen = new Set()
      for (const agent of arr) {
        seen.add(sessionId(agent))
        mount(agent)
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
    offCreated()
    offDisposed()
    clearInterval(timer)
    if (runtime.refreshAgentScopes === sweep) delete runtime.refreshAgentScopes
    for (const { off } of mounted.values()) { try { off() } catch {} }
    mounted.clear()
  }
}
