const ok = (value) => ({ ok: true, value })
const fail = (message) => ({ ok: false, error: { code: 'internal', message: String(message), details: {} } })

export function createRpc(runtime) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'config/get':
          return ok({ config: runtime.configStore.publicView(), dataDir: runtime.dataDir, imPath: runtime.imReader.path })
        case 'config/set': {
          const patch = payload && typeof payload === 'object' ? payload : {}
          const current = runtime.configStore.get()
          if (patch.embedding && typeof patch.embedding === 'object' && typeof patch.embedding.baseUrl === 'string' && current.embedding?.apiKey) {
            const origin = value => { try { return new URL(value).origin } catch { return '' } }
            if (origin(patch.embedding.baseUrl) !== origin(current.embedding.baseUrl) && typeof patch.embedding.apiKey !== 'string') {
              return fail('更换向量服务地址时，请重新填写或明确清除旧密钥')
            }
          }
          runtime.configStore.update(patch)
          runtime.refreshEmbeddingSpace?.()
          runtime.rebuild?.configChanged()
          runtime.refreshAgentScopes?.()
          return ok({ config: runtime.configStore.publicView() })
        }
        case 'test': {
          const e = await runtime.embedder.test()
          return ok(e)
        }
        case 'stats':
          return ok({ ...runtime.store.stats(), im: { available: runtime.imReader.available(), latest: runtime.imReader.latestSentAt(), groups: runtime.imReader.groups() } })
        case 'sync': {
          const r = await runtime.syncOnce({ drain: true })
          return ok(r)
        }
        case 'archive/query': {
          const { groupId, ...filters } = payload ?? {}
          return ok(runtime.store.archive.query(groupId, filters))
        }
        case 'embedding/rebuild/status':
          return ok(runtime.rebuild.status())
        case 'embedding/rebuild/start':
          if (payload?.confirm !== true) return fail('请先确认历史文本会发送给已保存的向量服务。')
          return ok(runtime.rebuild.start(payload.target))
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
          const entries = new Map(runtime.store.groups().map(g => [g.groupId, g]))
          for (const groupId of runtime.store.archive.groups()) {
            if (!entries.has(groupId)) entries.set(groupId, { groupId, people: 0, count: 0, latestAt: 0, chars: 0, vecBytes: 0 })
          }
          const groups = [...entries.values()].map(g => {
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
        case 'members/message-update': {
          const messageId = String(payload?.messageId || '').trim()
          const senderId = String(payload?.senderId || '').trim()
          const groupId = String(payload?.groupId || '').trim()
          const text = String(payload?.text || '').trim()
          if (!messageId) return fail('缺少 messageId')
          if (!senderId) return fail('缺少 senderId')
          if (!groupId) return fail('必须指定 groupId，避免跨群误改')
          if (!text) return fail('记忆内容不能为空')
          if (text.length > 10000) return fail('记忆内容不能超过 10000 字')
          const updated = runtime.store.updateMessage(messageId, groupId, senderId, text)
          if (!updated) return fail('找不到这条属于指定群和成员的记忆')
          return ok({ messageId, groupId, senderId, text })
        }
        case 'members/message-delete': {
          const messageId = String(payload?.messageId || '').trim()
          const senderId = String(payload?.senderId || '').trim()
          const groupId = String(payload?.groupId || '').trim()
          if (!messageId) return fail('缺少 messageId')
          if (!senderId) return fail('缺少 senderId')
          if (!groupId) return fail('必须指定 groupId，避免跨群误删')
          if (payload?.confirm !== true) return fail('需要 confirm: true 才执行删除')
          const deleted = runtime.store.deleteMessage(messageId, groupId, senderId)
          if (!deleted) return fail('找不到这条属于指定群和成员的记忆')
          runtime.store.vacuum()
          return ok({ messageId, groupId, senderId, deleted: true, dbBytes: runtime.store.sizeBytes() })
        }
        case 'members/delete': {
          const senderId = String(payload?.senderId || '').trim()
          const groupId = String(payload?.groupId || '').trim()
          if (!senderId) return fail('缺少 senderId')
          if (!groupId) return fail('必须指定 groupId，避免跨群误删')
          if (payload?.confirm !== true) return fail('需要 confirm: true 才执行删除')
          if (!runtime.imReader.available()) return fail('IM 历史库不可用，无法确认要清除的完整范围，请稍后重试')
          const through = runtime.imReader.latestArrival(runtime.store.getSyncCursor())
          const deleted = runtime.store.deleteSender(senderId, groupId, through)
          return ok({ senderId, groupId, deleted, dbBytes: runtime.store.sizeBytes() })
        }
        case 'preview': {
          const senderId = String(payload?.senderId || '').trim()
          if (!senderId) return fail('缺少 senderId')
          const groupId = String(payload?.groupId || '').trim()
          if (!groupId) return fail('请选择要预览的群聊')
          const query = typeof payload?.query === 'string' ? payload.query.trim().slice(0, 4000) : ''
          const saved = runtime.configStore.get()
          if (!saved.enabled) return fail('插件已禁用')
          const cfg = saved.embedding?.enabled === false ? { ...saved, recall: { ...saved.recall, semantic: 0 } } : saved
          const { recallAsync, formatMemoryBlock } = await import('./recall.js')
          const embedder = { embedOne: runtime.embedOne || (text => runtime.embedder.embedOne(text)) }
          const r = await recallAsync({ store: runtime.store, embedder, senderId, groupId, query, cfg })
          return ok({ ...r, block: formatMemoryBlock({ senderName: payload?.senderName || '', userId: senderId, ...r, maxChars: cfg.inject.maxChars }) })
        }
        default:
          return fail(`未知端点：${endpoint}`)
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
}
