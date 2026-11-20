const ok = (value) => ({ ok: true, value })
const fail = (message) => ({ ok: false, error: { code: 'internal', message: String(message) } })

export function createRpc(runtime) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'config/get':
          return ok({ config: runtime.configStore.publicView(), dataDir: runtime.dataDir, imPath: runtime.imReader.path })
        case 'config/set': {
          const patch = payload && typeof payload === 'object' ? payload : {}
          runtime.configStore.update(patch)
          return ok({ config: runtime.configStore.publicView() })
        }
        case 'test': {
          const e = await runtime.embedder.test()
          return ok(e)
        }
        case 'stats':
          return ok({ ...runtime.store.stats(), im: { available: runtime.imReader.available(), latest: runtime.imReader.latestSentAt(), groups: runtime.imReader.groups() } })
        case 'sync': {
          const r = await runtime.syncOnce()
          return ok(r)
        }
        case 'workspaces/list': {
          // DSH 已注册的工作区（设置页「选择目录」用，不让人手敲路径）
          let list = []
          try {
            const reg = runtime.ctx?.workspaceRegistry
            if (reg && typeof reg.list === 'function') {
              list = reg.list().map(w => ({
                id: String(w.id || ''),
                path: String(w.path || ''),
                title: String(w.title || ''),
                sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
              }))
            }
          } catch (e) {
            return fail(`读工作区列表失败：${e instanceof Error ? e.message : String(e)}`)
          }
          return ok({ workspaces: list })
        }
        case 'groups/list': {
          // 群维度：先列群，再按群看成员，避免跨群删错
          const info = new Map((runtime.store.groupInfo() || []).map(g => [g.groupId, g]))
          const groups = runtime.store.groups().map(g => {
            const meta = info.get(g.groupId) || {}
            const chan = meta.channel === 'feishu' ? '飞书' : meta.channel === 'qq' ? 'QQ群' : '群'
            const name = meta.name || meta.autoName || ''
            const qq = meta.qqNumber || ''
            const label = name
              ? `${name}${qq ? `（${chan} ${qq}）` : ''}`
              : `${chan}${qq ? ` · ${qq}` : ` · ${g.groupId.slice(0, 8)}`}`
            return { ...g, channel: meta.channel || '', platformGroupId: meta.platformGroupId || '', qqNumber: qq, name, autoName: meta.autoName || '', label }
          })
          return ok({ groups, dbBytes: runtime.store.sizeBytes() })
        }
        case 'groups/set': {
          // 人工给某个群填名字和群号（群名 QQ 接口拿不到）
          const groupId = String(payload?.groupId || '').trim()
          if (!groupId) return fail('缺少 groupId')
          const patch = {}
          if (payload?.name !== undefined) patch.name = String(payload.name).slice(0, 40)
          if (payload?.qqNumber !== undefined) patch.qqNumber = String(payload.qqNumber).replace(/[^0-9]/g, '').slice(0, 20)
          if (!Object.keys(patch).length) return fail('没有要改的字段')
          runtime.store.setGroupInfo(groupId, patch)
          return ok({ groupId, ...patch })
        }
        case 'members/list': {
          const groupId = String(payload?.groupId || '').trim()
          return ok({ members: runtime.store.members(groupId || undefined), groupId, dbBytes: runtime.store.sizeBytes() })
        }
        case 'members/messages': {
          const senderId = String(payload?.senderId || '').trim()
          if (!senderId) return fail('缺少 senderId')
          const groupId = String(payload?.groupId || '').trim()
          return ok({ messages: runtime.store.messagesOf(senderId, groupId || undefined, payload?.limit, payload?.offset) })
        }
        case 'members/delete': {
          const senderId = String(payload?.senderId || '').trim()
          const groupId = String(payload?.groupId || '').trim()
          if (!senderId) return fail('缺少 senderId')
          if (!groupId) return fail('必须指定 groupId，避免跨群误删')
          if (payload?.confirm !== true) return fail('需要 confirm: true 才执行删除')
          const deleted = runtime.store.deleteSender(senderId, groupId)
          runtime.store.vacuum()
          return ok({ senderId, groupId, deleted, dbBytes: runtime.store.sizeBytes() })
        }
        case 'preview': {
          const senderId = String(payload?.senderId || '').trim()
          if (!senderId) return fail('缺少 senderId')
          let query = String(payload?.query || '').trim()
          if (!query) {
            // 没给 query 就用这个人最后一条已入库的消息，语义召回才有意义
            const last = runtime.store.recentBySender(senderId, 1)
            query = String(last?.[0]?.text || '').trim()
          }
          const cfg = runtime.configStore.get()
          const { recallAsync, formatMemoryBlock } = await import('./recall.js')
          const r = await recallAsync({ store: runtime.store, embedder: runtime.embedder, senderId, query, cfg })
          return ok({ ...r, block: formatMemoryBlock({ senderName: payload?.senderName || '', userId: senderId, recent: r.recent, semantic: r.semantic, maxChars: cfg.inject.maxChars }) })
        }
        default:
          return fail(`未知端点：${endpoint}`)
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
}
