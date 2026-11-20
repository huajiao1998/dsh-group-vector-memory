/**
 * 群聊记忆注入 —— 走 DSH 的 agent/pre-step waterfall（官方钩子，可以 await）。
 *
 * 历史教训（都踩过）：
 *   1. agent.inject() 塞 inbox next-step → turn 不消费就积压，群消息一密压垮队列。
 *   2. systemPrompt.context/section 的 text() 是同步的 → 塞不进 300ms 的向量化。
 *   3. 「会话里最后一条」在装配时拿到的永远是上一轮（这一轮的 user 消息还没落盘）。
 *
 * 正解：agent/pre-step 是 waterfall 事件，DSH 用 `await dispatch.waterfall(...)` 调用它，
 *   参数里带着这一轮 claim 到的 messages，而且允许返回修改后的 messages。
 *   在这里 await 向量化 + 召回，然后把记忆块追加进这一轮的消息 —— 模型必然看到。
 *   （dsh-local-vector-memory 的自动召回也是走这个钩子。）
 */

import { randomUUID } from 'node:crypto'
import { cleanText } from './recall.js'
import { memoryToolDefinition } from './tool.js'

const SRC_RE = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/i
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

export function parseImSource(eventOrText) {
  const content = eventOrText?.data?.content
  let text = ''
  if (Array.isArray(content)) {
    text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  } else if (typeof eventOrText === 'string') {
    text = eventOrText
  }
  const m = SRC_RE.exec(text)
  if (!m) return null
  try {
    const meta = JSON.parse(m[1].trim())
    return meta && typeof meta === 'object' ? meta : null
  } catch {
    return null
  }
}

function textOfMessage(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  }
  return typeof message?.text === 'string' ? message.text : ''
}

function isGroupMeta(meta) {
  return String(meta?.conversationType || '').toLowerCase() === 'group' || Boolean(meta?.chatId)
}

/** 这个会话的工作目录算不算在启用的工作区里（空配置 = 全启用） */
export function workspaceAllowed(cwd, workspaces) {
  const norm = (p) => String(p || '').trim().replace(/\/+$/, '')   // 去尾部斜杠再比，避免 /a 和 /a/ 被当成两回事
  const list = Array.isArray(workspaces) ? workspaces.map(norm).filter(Boolean) : []
  if (!list.length) return true
  const dir = norm(cwd)
  if (!dir) return false
  return list.some(base => dir === base || dir.startsWith(`${base}/`))
}

export function cleanQuery(text) {
  return cleanText(String(text || '').replace(SRC_RE, ' '))
}

/** 从这一轮的消息里找出最后一条 dsh-im 群消息 */
export function findGroupMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = textOfMessage(messages[i])
    const meta = parseImSource(text)
    if (meta && isGroupMeta(meta)) return { meta, text, message: messages[i] }
  }
  return null
}

export function mountAgent(agent, runtime) {
  const disposers = []

  // 按工作区启用：不匹配的会话不挂注入、也不注册查询工具（别污染别的工作区上下文）
  const cfg0 = runtime.configStore.get()
  const cwd = agent?.session?.header?.cwd || agent?.session?.cwd || agent?.cwd || ''
  if (!workspaceAllowed(cwd, cfg0.workspaces)) {
    runtime.log?.(`[gvm] 跳过会话（工作区不在启用列表） cwd=${cwd || '?'}`)
    const skip = () => {}
    skip.skipped = true
    return skip
  }

  // 查询工具：注册到这个 agent 的 scope，只在这个会话的工具列表里出现
  try {
    const offTool = agent.ctx.tools.register(memoryToolDefinition(runtime))
    if (typeof offTool === 'function') disposers.push(offTool)
    else if (offTool && typeof offTool.off === 'function') disposers.push(() => offTool.off())
    runtime.log?.('[gvm] 已注册查询工具（本会话）')
  } catch (e) {
    runtime.log?.(`[gvm] 注册查询工具失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
      try {
        runtime.log(`[gvm-debug] pre-step 触发 messages=${Array.isArray(payload?.messages) ? payload.messages.length : 'N/A'}`)
        const hit = findGroupMessage(payload?.messages)
        if (!hit) return next()

        const cfg = runtime.configStore.get()
        if (!cfg.inject?.enabled) return next()

        const senderId = String(hit.meta.senderId || '')
        if (!senderId) return next()

        const query = cleanQuery(hit.text)
        const t0 = Date.now()
        // 这里可以等 —— pre-step 是 await 的 waterfall，模型还没被调用
        const vec = await runtime.embedOne(query)
        const vecMs = Date.now() - t0
        const { recent, semantic, literal } = runtime.recall(senderId, query, vec?.vector || null)
        if (!recent.length && !semantic.length && !(literal && literal.length)) return next()

        const block = runtime.format({
          senderName: String(hit.meta.senderName || ''),
          userId: senderId,
          recent,
          semantic,
          literal: literal || [],
        })
        const base = await next()
        if (base?.kind === 'reject') return base

        const memoryMessage = createUserMessage({
          source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: 'group-vector-context', text: block }] },
          content: [{ type: 'text', text: block }],
        })
        const messages = [...(base?.messages || payload.messages || []), memoryMessage]
        runtime.log(`[gvm-inject] 注入成功 sender=${String(hit.meta.senderName || senderId).slice(0, 12)} recent=${recent.length} literal=${(literal || []).length} semantic=${semantic.length} 向量=${vecMs}ms 总计=${Date.now() - t0}ms chars=${block.length}`)
        return { ...(base || { kind: 'enter' }), messages }
      } catch (e) {
        runtime.log(`[gvm-inject] 失败（放行）: ${e instanceof Error ? e.message : String(e)}`)
        return next()
      }
    })
    if (typeof off === 'function') disposers.push(off)
    console.log('[gvm] 已挂 agent/pre-step')
  } catch (e) {
    console.log(`[gvm] 挂 agent/pre-step 失败: ${e.message}`)   // 启动错误始终报
  }

  return () => { for (const d of disposers) { try { d() } catch {} } }
}

export function installInjector(ctx, runtime) {
  const mounted = new Map()

  const sweep = () => {
    try {
      const agents = ctx.agents
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      const arr = Array.isArray(list) ? list : (list && typeof list.values === 'function' ? [...list.values()] : [])
      for (const agent of arr) {
        const sid = String(agent?.session?.id || agent?.sessionId || agent?.id || '')
        if (!sid) continue
        const prev = mounted.get(sid)
        if (prev && prev.agent === agent) continue
        if (prev) { try { prev.off() } catch {} mounted.delete(sid) }
        try {
          const off = mountAgent(agent, runtime)
          mounted.set(sid, { agent, off })
          if (!off?.skipped) console.log(`[gvm] 已监听会话 ${sid.slice(0, 24)}（只注册 pre-step，不读事件流）`)
        } catch (e) {
          console.log(`[gvm] 挂载失败 ${sid.slice(0, 24)}: ${e.message}`)
        }
      }
    } catch (e) {
      console.log(`[gvm] 遍历 agents 失败: ${e.message}`)
    }
  }

  sweep()
  const timer = setInterval(sweep, 10000)
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    clearInterval(timer)
    for (const { off } of mounted.values()) { try { off() } catch {} }
    mounted.clear()
  }
}
