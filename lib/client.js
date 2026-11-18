window.__ModuleLoader__.load({
  id: 'dsh-group-vector-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    const RPC_CHANNEL = '/gvm'

    async function callRpc(rpc, endpoint, payload) {
      const res = await rpc.call(RPC_CHANNEL, endpoint, payload || {})
      if (!res || res.ok !== true) throw new Error(res?.error?.message || '调用失败')
      return res.value
    }

    const label = (text) => h('div', { style: { fontSize: 12, color: 'var(--fg-muted,#888)', marginBottom: 4 } }, text)
    const box = (children, extra) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 12px', ...extra } }, children)
    const row = (children, extra) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', ...extra } }, children)
    const inputStyle = { flex: 1, minWidth: 220, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border,#444)', background: 'var(--bg-input,transparent)', color: 'inherit', fontSize: 13 }
    const btnStyle = { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border,#555)', background: 'var(--bg-button,transparent)', color: 'inherit', cursor: 'pointer', fontSize: 13 }
    const field = (title, value, onChange, opts) => h('div', null, label(title), h('input', { type: opts?.type || 'text', value: value == null ? '' : String(value), placeholder: opts?.placeholder || '', disabled: !!opts?.disabled, onChange: e => onChange(e.target.value), style: { ...inputStyle, width: '100%', boxSizing: 'border-box' } }))

    function GroupMemorySettings({ rpc }) {
      const [cfg, setCfg] = useState(null)
      const [stats, setStats] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [preview, setPreview] = useState(null)
      const [apiKeyInput, setApiKeyInput] = useState('')
      const [groups, setGroups] = useState([])
      const [dbBytes, setDbBytes] = useState(0)
      const [openGroup, setOpenGroup] = useState('')
      const [groupMembers, setGroupMembers] = useState({})
      const [openMember, setOpenMember] = useState('')
      const [memberMsgs, setMemberMsgs] = useState({})
      const [pendingDelete, setPendingDelete] = useState('')

      const refresh = useCallback(async () => {
        try {
          const [c, s, g] = await Promise.all([callRpc(rpc, 'config/get'), callRpc(rpc, 'stats'), callRpc(rpc, 'groups/list')])
          setCfg(c.config); setStats(s); setGroups(g.groups || []); setDbBytes(g.dbBytes || 0); setError('')
        } catch (e) { setError(e.message || String(e)) }
      }, [rpc])

      useEffect(() => { void refresh() }, [refresh])

      const patch = (fn) => { const next = JSON.parse(JSON.stringify(cfg)); fn(next); setCfg(next) }

      const save = async () => {
        setBusy('save'); setMsg('')
        try {
          const payload = JSON.parse(JSON.stringify({ embedding: cfg.embedding, recall: cfg.recall, inject: cfg.inject, enabled: cfg.enabled }))
          delete payload.embedding.apiKeyMasked; delete payload.embedding.apiKeySet
          if (apiKeyInput) payload.embedding.apiKey = apiKeyInput
          else delete payload.embedding.apiKey
          const r = await callRpc(rpc, 'config/set', payload)
          setCfg(r.config); setApiKeyInput(''); setMsg('已保存')
        } catch (e) { setError(e.message || String(e)) } finally { setBusy('') }
      }

      const test = async () => {
        setBusy('test'); setMsg('')
        try { const r = await callRpc(rpc, 'test'); setMsg(`连通 OK：${r.dims} 维，${r.ms} ms`) }
        catch (e) { setMsg('失败：' + (e.message || String(e))) } finally { setBusy('') }
      }

      const sync = async () => {
        setBusy('sync'); setMsg('')
        try { const r = await callRpc(rpc, 'sync'); setMsg(`同步完成：新增 ${r.added || 0} 条，向量化 ${r.embedded || 0} 条`); await refresh() }
        catch (e) { setMsg('失败：' + (e.message || String(e))) } finally { setBusy('') }
      }

      const toggleGroup = async (groupId) => {
        if (openGroup === groupId) { setOpenGroup(''); return }
        setOpenGroup(groupId); setOpenMember('')
        if (groupMembers[groupId]) return
        try {
          const r = await callRpc(rpc, 'members/list', { groupId })
          setGroupMembers(prev => ({ ...prev, [groupId]: r.members || [] }))
        } catch (e) { setMsg('读取失败：' + (e.message || String(e))) }
      }

      const toggleMember = async (groupId, senderId) => {
        const key = groupId + '|' + senderId
        if (openMember === key) { setOpenMember(''); return }
        setOpenMember(key)
        if (memberMsgs[key]) return
        try {
          const r = await callRpc(rpc, 'members/messages', { groupId, senderId, limit: 30 })
          setMemberMsgs(prev => ({ ...prev, [key]: r.messages || [] }))
        } catch (e) { setMsg('读取失败：' + (e.message || String(e))) }
      }

      const deleteMember = async (groupId, senderId) => {
        const key = groupId + '|' + senderId
        if (pendingDelete !== key) { setPendingDelete(key); setMsg('再点一次「确认删除」才会真的删（只删这个群里这个人的）'); return }
        setBusy('delete'); setMsg('')
        try {
          const r = await callRpc(rpc, 'members/delete', { groupId, senderId, confirm: true })
          setPendingDelete(''); setOpenMember('')
          setMemberMsgs(prev => { const n = { ...prev }; delete n[key]; return n })
          setGroupMembers(prev => { const n = { ...prev }; delete n[groupId]; return n })
          setMsg(`已删除 ${r.deleted} 条，库现在 ${(r.dbBytes / 1024).toFixed(0)} KB`)
          await refresh()
        } catch (e) { setMsg('删除失败：' + (e.message || String(e))) } finally { setBusy('') }
      }

      const runPreview = async () => {
        const me = (stats?.senders || [])[0]
        if (!me) { setMsg('还没有群消息'); return }
        setBusy('preview'); setMsg('')
        try {
          const r = await callRpc(rpc, 'preview', { senderId: me.sender_id, senderName: me.sender_name, query: '' })
          setPreview(r.block)
        } catch (e) { setMsg('失败：' + (e.message || String(e))) } finally { setBusy('') }
      }

      if (!cfg) return box([h('div', null, error ? '加载失败：' + error : '加载中…')])

      const senders = stats?.senders || []
      return box([
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '群聊按人向量记忆'),
        label('按 sender id 隔离：短期取这个人最近 N 条发言，长期按语义相似度召回以前说过的话。'),
        error ? h('div', { style: { color: '#e5484d', fontSize: 13 } }, error) : null,

        h('div', { style: { borderTop: '1px solid var(--border,#333)', paddingTop: 12, marginTop: 4 } }),
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '向量模型'),
        field('接口地址', cfg.embedding.baseUrl, v => patch(c => { c.embedding.baseUrl = v }), { placeholder: 'https://api.siliconflow.cn/v1' }),
        h('div', null, label('API Key' + (cfg.embedding.apiKeySet ? '（已设置，留空表示不改）' : '')),
          h('input', {
            type: 'text',
            value: apiKeyInput,
            placeholder: cfg.embedding.apiKeySet ? cfg.embedding.apiKeyMasked : 'sk-...',
            onChange: e => setApiKeyInput(e.target.value),
            style: { ...inputStyle, width: '100%', boxSizing: 'border-box' },
          })),
        field('模型名', cfg.embedding.model, v => patch(c => { c.embedding.model = v }), { placeholder: 'BAAI/bge-m3' }),

        h('div', { style: { borderTop: '1px solid var(--border,#333)', paddingTop: 12 } }),
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '召回'),
        row([
          h('div', { style: { flex: 1 } }, label('短期：最近几条'), h('input', { type: 'number', min: 0, max: 50, value: cfg.recall.recent, onChange: e => { const v = e.target.value; patch(c => { c.recall.recent = v === '' ? 0 : Math.max(0, Math.min(50, Math.floor(Number(v) || 0))) }) }, style: inputStyle })),
          h('div', { style: { flex: 1 } }, label('长期：语义召回几条'), h('input', { type: 'number', min: 0, max: 50, value: cfg.recall.semantic, onChange: e => { const v = e.target.value; patch(c => { c.recall.semantic = v === '' ? 0 : Math.max(0, Math.min(50, Math.floor(Number(v) || 0))) }) }, style: inputStyle })),
          h('div', { style: { flex: 1 } }, label('最低相似度'), h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: cfg.recall.minScore, onChange: e => { const v = e.target.value; patch(c => { c.recall.minScore = v === '' ? 0 : Math.max(0, Math.min(1, Number(v) || 0)) }) }, style: inputStyle })),
        ]),

        row([
          h('button', { style: btnStyle, disabled: !!busy, onClick: save }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { style: btnStyle, disabled: !!busy, onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
          h('button', { style: btnStyle, disabled: !!busy, onClick: sync }, busy === 'sync' ? '同步中…' : '立即同步'),
          h('button', { style: btnStyle, disabled: !!busy, onClick: runPreview }, busy === 'preview' ? '生成中…' : '预览召回'),
        ]),
        msg ? h('div', { style: { fontSize: 13, color: 'var(--fg-muted,#9aa)' } }, msg) : null,

        h('div', { style: { borderTop: '1px solid var(--border,#333)', paddingTop: 12 } }),
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '状态'),
        h('div', { style: { fontSize: 13, lineHeight: 1.7 } },
          `已收录消息 ${stats?.messages || 0} 条，已向量化 ${stats?.embedded || 0} 条`,
          h('br'),
          `IM 群历史库：${stats?.im?.available ? '可用' : '不可用'}，群 ${stats?.im?.groups?.length || 0} 个`,
          h('br'),
          `成员 ${senders.length} 个：` + (senders.slice(0, 8).map(s => `${s.sender_name || s.sender_id.slice(0, 8)}(${s.n})`).join('、') || '无'),
        ),
        h('div', { style: { borderTop: '1px solid var(--border,#333)', paddingTop: 12 } }),
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, `群聊记忆（${groups.length} 个群，库 ${(dbBytes / 1024).toFixed(0)} KB）`),
        h('div', { style: { fontSize: 12, color: 'var(--fg-muted,#888)', marginBottom: 8 } }, '先点群，再看这个群里的人；删除只清这个群里这个人的记忆，不会误删别的群。删完自动回收空间。'),
        groups.length === 0 ? h('div', { style: { fontSize: 12, color: 'var(--fg-muted,#888)' } }, '还没有群消息数据') : null,
        ...groups.map(grp => h('div', { key: grp.groupId, style: { border: '1px solid var(--border,#333)', borderRadius: 6, marginBottom: 6, overflow: 'hidden' } }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', flexWrap: 'wrap', cursor: 'pointer' }, onClick: () => toggleGroup(grp.groupId) }, [
            h('span', { key: 'n', style: { fontWeight: 600 } }, `${openGroup === grp.groupId ? '▾' : '▸'} ${grp.label}`),
            h('span', { key: 'm', style: { fontSize: 12, color: 'var(--fg-muted,#888)' } },
              `${grp.count} 条 · ${grp.people} 人 · 向量 ${(grp.vecBytes / 1024).toFixed(0)} KB · 最后 ${new Date(grp.latestAt).toLocaleString('zh-CN', { hour12: false })}`),
          ]),
          openGroup === grp.groupId ? h('div', { key: 'body', style: { padding: '0 8px 8px 20px' } },
            (groupMembers[grp.groupId] || []).length === 0
              ? h('div', { style: { fontSize: 12, color: 'var(--fg-muted,#888)' } }, '加载中…')
              : groupMembers[grp.groupId].map(mem => {
                  const key = grp.groupId + '|' + mem.senderId
                  const isOpen = openMember === key
                  const isPending = pendingDelete === key
                  return h('div', { key: mem.senderId, style: { borderTop: '1px solid var(--border,#2a2a2a)', paddingTop: 4, marginTop: 4 } }, [
                    h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                      h('button', {
                        key: 'name',
                        style: { ...btnStyle, flex: 1, textAlign: 'left', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 13 },
                        onClick: () => toggleMember(grp.groupId, mem.senderId),
                      }, `${isOpen ? '▾' : '▸'} ${mem.senderName || mem.senderId.slice(0, 10)}`),
                      h('span', { key: 'meta', style: { fontSize: 12, color: 'var(--fg-muted,#888)' } },
                        `${mem.count} 条 · 向量 ${(mem.vecBytes / 1024).toFixed(0)} KB · 最后 ${new Date(mem.latestAt).toLocaleString('zh-CN', { hour12: false })}`),
                      h('button', {
                        key: 'del',
                        style: { ...btnStyle, padding: '2px 8px', fontSize: 12, color: isPending ? '#fff' : '#e5484d', background: isPending ? '#e5484d' : 'transparent' },
                        disabled: !!busy,
                        onClick: () => deleteMember(grp.groupId, mem.senderId),
                      }, isPending ? '确认删除' : '删除'),
                    ]),
                    isOpen ? h('div', { key: 'msgs', style: { fontSize: 12, paddingLeft: 12 } },
                      (memberMsgs[key] || []).length === 0
                        ? h('div', { style: { color: 'var(--fg-muted,#888)' } }, '没有消息')
                        : memberMsgs[key].map((m2, i) => h('div', { key: i, style: { padding: '2px 0' } },
                            `${new Date(m2.sentAt).toLocaleString('zh-CN', { hour12: false })}  ${String(m2.text).replace(/<@[^>]+>/g, '@某人').slice(0, 120)}`))) : null,
                  ])
                }),
          ) : null,
        ])),

        preview ? h('div', null, label('召回预览'), h('pre', { style: { fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--bg-code,rgba(127,127,127,.08))', padding: 10, borderRadius: 6, maxHeight: 240, overflow: 'auto' } }, preview)) : null,
      ])
    }

    const modules = {}
    modules['./plugin.cjs'] = function (module, exports, require2) {
      exports.inject = ['slots', 'connection']
      exports.apply = function apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'group-vector-memory',
          order: 36,
          label: () => '群聊记忆',
          inject: () => ({ rpc: ctx.connection.rpc }),
        }, GroupMemorySettings))
      }
    }
    const cache = Object.create(null)
    function modRequire(id) {
      const factory2 = modules[id]
      if (!factory2) return require(id)
      const cached = cache[id]
      if (cached) return cached.exports
      const module2 = { exports: {} }
      cache[id] = module2
      factory2(module2, module2.exports, modRequire)
      return module2.exports
    }
    return modRequire('./plugin.cjs')
  },
})
