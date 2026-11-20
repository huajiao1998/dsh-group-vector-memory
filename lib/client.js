window.__ModuleLoader__.load({
  id: 'dsh-group-vector-memory',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useId, useRef, useState } = React
    const RPC_CHANNEL = '/gvm'
    const tabs = [['records', '群聊记录'], ['settings', '插件设置']]
    const formatCount = new Intl.NumberFormat('zh-CN')
    const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false })

    const styles = `
      .gvm-settings {
        --gvm-ink: var(--dsw-alias-label-primary, #18243b);
        --gvm-muted: var(--dsw-alias-label-secondary, #56657c);
        --gvm-border: var(--dsw-alias-border-l2, #dce4ef);
        --gvm-surface: var(--dsw-alias-bg-layer-1, #fff);
        --gvm-fill: var(--dsw-alias-bg-module-platform, #f5f7fa);
        --gvm-accent: var(--dsw-alias-state-business-primary, #285aca);
        --gvm-tint: color-mix(in srgb, var(--gvm-accent) 8%, var(--gvm-surface));
        --gvm-success: var(--dsw-alias-state-success-primary, #168048);
        --gvm-danger: var(--dsw-alias-state-error-primary, #bd2e3b);
        color: var(--gvm-ink); color-scheme: light; font-size: 13px; line-height: 1.5;
        display: grid; gap: 16px; min-width: 0; container: gvm / inline-size;
      }
      body[data-ds-dark-theme] .gvm-settings {
        color-scheme: dark;
        --gvm-ink: var(--dsw-alias-label-primary, #ecf1fa);
        --gvm-muted: var(--dsw-alias-label-secondary, #adb9ce);
        --gvm-border: var(--dsw-alias-border-l2, #384256);
        --gvm-surface: var(--dsw-alias-bg-layer-1, #1b2230);
        --gvm-fill: var(--dsw-alias-bg-module-platform, #242d3c);
        --gvm-accent: var(--dsw-alias-state-business-primary, #8bb2ff);
        --gvm-success: var(--dsw-alias-state-success-primary, #73dda1);
        --gvm-danger: var(--dsw-alias-state-error-primary, #ff8990);
      }
      .gvm-settings *, .gvm-settings *::before, .gvm-settings *::after { box-sizing: border-box; }
      .gvm-settings :where(h2, h3, p, dl, dd, ul, pre) { margin: 0; }
      .gvm-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .gvm-spread { justify-content: space-between; }
      .gvm-heading { font-size: 20px; line-height: 1.35; font-weight: 700; }
      .gvm-title { font-size: 15px; line-height: 1.4; font-weight: 650; }
      .gvm-help { color: var(--gvm-muted); font-size: 12px; overflow-wrap: anywhere; }
      .gvm-card-head .gvm-help { margin-top: 3px; }
      .gvm-source { display: inline-flex; align-items: center; gap: 6px; color: var(--gvm-muted); font-size: 12px; }
      .gvm-source::before { content: ''; width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
      .gvm-source[data-available='true']::before { background: var(--gvm-success); }
      .gvm-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 10px 14px; border-radius: 8px; background: var(--gvm-fill); }
      .gvm-metric + .gvm-metric { border-inline-start: 1px solid var(--gvm-border); padding-inline-start: 14px; }
      .gvm-metric dt { color: var(--gvm-muted); font-size: 12px; }
      .gvm-metric dd { font-size: 20px; line-height: 1.35; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .gvm-tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--gvm-border); }
      .gvm-tab {
        min-height: 36px; border: 0; border-bottom: 2px solid transparent; padding: 5px 3px;
        color: var(--gvm-muted); background: transparent; font: inherit; font-weight: 550; cursor: pointer;
      }
      .gvm-tab:hover { color: var(--gvm-ink); }
      .gvm-tab[aria-selected='true'] { color: var(--gvm-ink); border-bottom-color: var(--gvm-accent); font-weight: 650; }
      .gvm-stack, .gvm-card { display: grid; gap: 12px; min-width: 0; }
      .gvm-form > .gvm-card + .gvm-card { border-top: 1px solid var(--gvm-border); padding-top: 12px; }
      .gvm-card-head { align-items: flex-start; }
      .gvm-button {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px;
        border: 1px solid var(--gvm-border); border-radius: 8px; padding: 5px 11px;
        font: inherit; font-weight: 550; color: var(--gvm-ink); background: var(--gvm-surface); cursor: pointer;
      }
      .gvm-button[data-tone='primary'] { background: var(--gvm-accent); border-color: transparent; color: var(--gvm-surface); }
      .gvm-button[data-tone='danger'] { color: var(--gvm-danger); }
      .gvm-button[data-tone='quiet'] { background: transparent; border-color: transparent; color: var(--gvm-muted); padding-inline: 7px; }
      .gvm-button:hover:not(:disabled) { background: var(--gvm-fill); }
      .gvm-button[data-tone='primary']:hover:not(:disabled) {
        background: color-mix(in srgb, var(--gvm-accent) 88%, var(--gvm-ink));
      }
      .gvm-button:disabled { opacity: .55; cursor: default; }
      .gvm-settings :where(button, input, summary):focus-visible { outline: 2px solid var(--gvm-accent); outline-offset: 2px; }
      .gvm-list { display: grid; gap: 6px; min-width: 0; }
      .gvm-item { border: 1px solid var(--gvm-border); border-radius: 8px; min-width: 0; }
      .gvm-entry, .gvm-option {
        display: flex; gap: 10px; align-items: center; min-width: 0; width: 100%;
        border: 0; border-radius: 7px; background: transparent; padding: 9px 10px; min-height: 44px;
        font: inherit; color: inherit; text-align: start; cursor: pointer;
      }
      .gvm-entry:hover, .gvm-option:hover:not(:disabled), .gvm-entry[aria-expanded='true'] { background: var(--gvm-fill); }
      .gvm-option:disabled { cursor: default; }
      .gvm-name { display: grid; gap: 2px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .gvm-name strong { font-weight: 620; }
      .gvm-channel {
        display: grid; place-items: center; width: 34px; height: 34px; flex: none;
        border-radius: 9px; background: var(--gvm-tint); color: var(--gvm-accent);
        font-size: 11px; font-weight: 700;
      }
      .gvm-chevron { flex: none; color: var(--gvm-muted); }
      .gvm-group-body { display: grid; gap: 10px; padding: 10px; border-top: 1px solid var(--gvm-border); }
      .gvm-members { list-style: none; padding: 0; }
      .gvm-members > li + li { border-top: 1px solid var(--gvm-border); }
      .gvm-member-body { display: grid; gap: 8px; padding: 4px 10px 10px; }
      .gvm-messages { list-style: none; padding: 0; display: grid; gap: 5px; max-height: 250px; overflow: auto; }
      .gvm-messages li, .gvm-preview { border-radius: 8px; padding: 8px 10px; background: var(--gvm-fill); overflow-wrap: anywhere; }
      .gvm-messages p, .gvm-preview { white-space: pre-wrap; }
      .gvm-preview { max-height: 240px; overflow: auto; font-size: 12px; }
      .gvm-message-actions { margin-top: 6px; gap: 4px; }
      .gvm-message-actions .gvm-button { min-height: 27px; padding: 3px 8px; font-size: 12px; }
      .gvm-message-edit { display: grid; gap: 7px; }
      .gvm-message-edit textarea { min-height: 74px; resize: vertical; background: var(--gvm-surface); }
      .gvm-meta summary { width: fit-content; color: var(--gvm-muted); cursor: pointer; }
      .gvm-meta[open] summary { margin-bottom: 8px; }
      .gvm-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 145px), 1fr)); gap: 10px; }
      .gvm-field { display: grid; align-content: start; gap: 4px; min-width: 0; }
      .gvm-field > span { font-weight: 550; }
      .gvm-input {
        width: 100%; min-width: 0; min-height: 36px; padding: 6px 9px;
        border: 1px solid var(--gvm-border); border-radius: 8px; background: var(--gvm-fill);
        color: var(--gvm-ink); font: inherit;
      }
      .gvm-input::placeholder { color: var(--gvm-muted); }
      .gvm-input:disabled { opacity: .65; }
      .gvm-check { display: inline-flex; gap: 8px; align-items: center; width: fit-content; cursor: pointer; }
      .gvm-check input { accent-color: var(--gvm-accent); width: 15px; height: 15px; margin: 0; }
      .gvm-selected { display: flex; padding: 4px 6px 4px 10px; gap: 8px; align-items: center; border-radius: 8px; background: var(--gvm-fill); }
      .gvm-option-list { max-height: 230px; overflow: auto; border: 1px solid var(--gvm-border); border-radius: 9px; }
      .gvm-option + .gvm-option { border-top: 1px solid var(--gvm-border); }
      .gvm-empty, .gvm-notice, .gvm-confirm { border-radius: 8px; padding: 9px 10px; overflow-wrap: anywhere; }
      .gvm-empty { background: var(--gvm-fill); color: var(--gvm-muted); }
      .gvm-notice, .gvm-confirm { background: var(--gvm-tint); }
      .gvm-notice[data-error='true'], .gvm-confirm {
        color: var(--gvm-danger); background: color-mix(in srgb, var(--gvm-danger) 8%, var(--gvm-surface));
      }
      .gvm-confirm .gvm-row { margin-top: 6px; }
      .gvm-footer { border-top: 1px solid var(--gvm-border); padding-top: 12px; justify-content: flex-end; }
      @container gvm (max-width: 390px) {
        .gvm-metrics { padding-inline: 10px; }
        .gvm-metric + .gvm-metric { padding-inline-start: 8px; }
      }
    `

    async function callRpc(rpc, endpoint, payload = {}) {
      const res = await rpc.call(RPC_CHANNEL, endpoint, payload)
      if (!res || res.ok !== true) throw new Error(res?.error?.message || '调用失败')
      return res.value
    }

    function button(label, props = {}) {
      return h('button', { type: 'button', className: 'gvm-button', ...props }, label)
    }

    function field(label, props, hint) {
      return h('label', { className: 'gvm-field' },
        h('span', null, label), h('input', { className: 'gvm-input', ...props }),
        hint ? h('small', { className: 'gvm-help' }, hint) : null)
    }

    function formFromConfig(config) {
      return {
        baseUrl: config.embedding.baseUrl ?? '', model: config.embedding.model ?? '', apiKey: '',
        recent: String(config.recall.recent), semantic: String(config.recall.semantic),
        minScore: String(config.recall.minScore), debug: !!config.debug,
      }
    }

    function formatSize(bytes) {
      const kb = (Number(bytes) || 0) / 1024
      return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
    }

    function timeLabel(ms) {
      return Number(ms) > 0 ? formatDate.format(Number(ms)) : ''
    }

    function GroupMemorySettings({ rpc }) {
      const id = useId()
      const [config, setConfig] = useState(null)
      const [form, setForm] = useState(null)
      const [records, setRecords] = useState(null)
      const [initialError, setInitialError] = useState('')
      const [tab, setTab] = useState('records')
      const [busy, setBusy] = useState('')
      const locked = useRef(false)
      const [notice, setNotice] = useState(null)
      const [preview, setPreview] = useState(null)
      const [openGroup, setOpenGroup] = useState('')
      const [openMember, setOpenMember] = useState('')
      const [members, setMembers] = useState({})
      const [messages, setMessages] = useState({})
      const [pendingDelete, setPendingDelete] = useState('')
      const [editingMessage, setEditingMessage] = useState('')
      const [editingText, setEditingText] = useState('')
      const [pendingMessageDelete, setPendingMessageDelete] = useState('')
      const [groupDrafts, setGroupDrafts] = useState({})
      const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
      const [workspaces, setWorkspaces] = useState([])

      const refreshRecords = useCallback(async () => {
        const [stats, groups] = await Promise.all([callRpc(rpc, 'stats'), callRpc(rpc, 'groups/list')])
        setRecords({ stats, groups: groups.groups || [], dbBytes: groups.dbBytes })
      }, [rpc])

      const initialize = useCallback(async () => {
        setInitialError('')
        try {
          const [value] = await Promise.all([callRpc(rpc, 'config/get'), refreshRecords()])
          setConfig(value.config)
          setForm(formFromConfig(value.config))
        } catch (error) { setInitialError(error.message || String(error)) }
      }, [rpc, refreshRecords])
      useEffect(() => { void initialize() }, [initialize])

      async function act(action, task) {
        if (locked.current) return
        locked.current = true
        setBusy(action)
        setNotice(null)
        try {
          const text = await task()
          if (text) setNotice({ action, text })
        } catch (error) {
          setNotice({ action, error: true, text: error.message || String(error) })
        } finally {
          locked.current = false
          setBusy('')
        }
      }

      function status(...actions) {
        if (!notice || !actions.includes(notice.action)) return null
        return h('div', { className: 'gvm-notice', 'data-error': !!notice.error, role: notice.error ? 'alert' : 'status' }, notice.text)
      }

      function updateField(key, value) {
        setForm(previous => ({ ...previous, [key]: value }))
      }

      function saveSettings(event) {
        event.preventDefault()
        void act('save', async () => {
          const embedding = { baseUrl: form.baseUrl, model: form.model }
          if (form.apiKey) embedding.apiKey = form.apiKey
          const recall = { recent: Number(form.recent), semantic: Number(form.semantic), minScore: Number(form.minScore) }
          const { config: saved } = await callRpc(rpc, 'config/set', { embedding, recall, debug: form.debug })
          setConfig(saved)
          setForm(formFromConfig(saved))
          return '插件设置已保存。'
        })
      }

      function toggleWorkspacePicker() {
        if (workspacePickerOpen) { setWorkspacePickerOpen(false); return }
        void act('workspace-list', async () => {
          const value = await callRpc(rpc, 'workspaces/list')
          setWorkspaces((value.workspaces || []).filter(item => item.path))
          setWorkspacePickerOpen(true)
        })
      }

      function saveWorkspaces(next) {
        void act('workspace-save', async () => {
          const { config: saved } = await callRpc(rpc, 'config/set', { workspaces: next })
          setConfig(saved)
          return next.length ? `已保存 ${next.length} 个启用工作区。` : '已恢复为全部工作区启用。'
        })
      }

      async function loadList(update, key, endpoint, payload, fieldName, details = {}) {
        const request = { ...details, loading: true }
        update(previous => ({ ...previous, [key]: request }))
        let result
        try {
          const data = await callRpc(rpc, endpoint, payload)
          result = { ...details, rows: data[fieldName] || [] }
        } catch (error) { result = { ...details, error: error.message || String(error) } }
        update(previous => previous[key] === request ? { ...previous, [key]: result } : previous)
      }

      const loadMembers = groupId => loadList(setMembers, groupId, 'members/list', { groupId }, 'members')
      const messagePageSize = 30
      const loadMessages = (groupId, senderId, key, offset = messages[key]?.offset ?? 0) =>
        loadList(setMessages, key, 'members/messages', { groupId, senderId, limit: messagePageSize, offset }, 'messages', { offset })

      function showList(result, retry, emptyText, render) {
        if (!result || result.loading) return h('p', { className: 'gvm-empty', role: 'status' }, '正在读取…')
        if (result.error) return h('div', { className: 'gvm-empty gvm-row', role: 'alert' },
          h('span', null, `读取失败：${result.error}`), button('重试', { onClick: retry }))
        if (!result.rows.length) return h('p', { className: 'gvm-empty' }, emptyText)
        return render(result.rows)
      }

      function toggleGroup(groupId) {
        setOpenGroup(openGroup === groupId ? '' : groupId)
        setOpenMember('')
        setPendingDelete('')
        setPendingMessageDelete('')
        setEditingMessage('')
        setEditingText('')
        if (openGroup !== groupId) void loadMembers(groupId)
      }

      function toggleMember(groupId, senderId, key) {
        setOpenMember(openMember === key ? '' : key)
        setPendingDelete('')
        setPendingMessageDelete('')
        setEditingMessage('')
        setEditingText('')
        if (openMember !== key) void loadMessages(groupId, senderId, key)
      }

      function saveGroup(groupId, patch) {
        void act('group', async () => {
          await callRpc(rpc, 'groups/set', { groupId, ...patch })
          await refreshRecords()
          setGroupDrafts(previous => {
            const next = { ...previous }
            delete next[groupId]
            return next
          })
          return '群信息已保存。'
        })
      }

      function deleteMember(groupId, senderId, key) {
        if (pendingDelete !== key) return
        void act('delete', async () => {
          const value = await callRpc(rpc, 'members/delete', { groupId, senderId, confirm: true })
          setPendingDelete('')
          setOpenMember('')
          setMessages(previous => {
            const next = { ...previous }
            delete next[key]
            return next
          })
          await Promise.all([loadMembers(groupId), refreshRecords()])
          return `已清除该成员在此群的 ${value.deleted} 条记忆。`
        })
      }

      function updateMessage(groupId, senderId, message, messageKey) {
        const text = editingText.trim()
        if (!text) return
        void act('message-update', async () => {
          await callRpc(rpc, 'members/message-update', { messageId: message.id, groupId, senderId, text })
          setEditingMessage('')
          setEditingText('')
          await Promise.all([
            loadMessages(groupId, senderId, messageKey),
            loadMembers(groupId),
            refreshRecords(),
          ])
          return '这条记忆已修改，旧向量已失效，下一轮同步会重新向量化。'
        })
      }

      function deleteMessage(groupId, senderId, message, memberKey, messageKey) {
        if (pendingMessageDelete !== messageKey) {
          setPendingMessageDelete(messageKey)
          return
        }
        void act('message-delete', async () => {
          await callRpc(rpc, 'members/message-delete', { messageId: message.id, groupId, senderId, confirm: true })
          setPendingMessageDelete('')
          setEditingMessage('')
          const currentPage = messages[memberKey]
          const offset = currentPage?.offset ?? 0
          await Promise.all([
            loadMessages(groupId, senderId, memberKey, currentPage?.rows?.length === 1 ? Math.max(0, offset - messagePageSize) : offset),
            loadMembers(groupId),
            refreshRecords(),
          ])
          return '这条记忆已删除，后续同步不会把它恢复。'
        })
      }

      function syncRecords() {
        void act('sync', async () => {
          const value = await callRpc(rpc, 'sync')
          if (value.skipped === '插件已禁用') return value.skipped
          const reads = [refreshRecords()]
          if (openGroup) reads.push(loadMembers(openGroup))
          if (openMember && openGroup) reads.push(loadMessages(openGroup, openMember.slice(openGroup.length + 1), openMember))
          await Promise.all(reads)
          const summary = `新增 ${value.added || 0} 条，向量化 ${value.embedded || 0} 条`
          if (value.embedError) throw new Error(`${summary}。向量化失败：${value.embedError}`)
          return `${summary}。${value.skipped || ''}`
        })
      }

      function previewRecall() {
        void act('preview', async () => {
          const member = records.stats.senders?.[0]
          if (!member) return '还没有可预览的群聊记录。'
          const value = await callRpc(rpc, 'preview', { senderId: member.sender_id, senderName: member.sender_name, query: '' })
          setPreview(value.block || '没有召回结果。')
        })
      }

      if (!config || !records || !form) return h('div', { className: 'gvm-settings' },
        h('style', null, styles),
        initialError
          ? h('div', { className: 'gvm-card', role: 'alert' }, h('p', null, `加载失败：${initialError}`), button('重试', { onClick: initialize }))
          : h('p', { className: 'gvm-empty', role: 'status' }, '正在加载群聊记忆…'))

      const { stats, groups, dbBytes } = records
      const available = !!stats.im?.available
      const selected = config.workspaces || []
      const savedForm = formFromConfig(config)
      const dirty = Object.keys(form).some(key => form[key] !== savedForm[key])
      const blocked = !!busy
      const fieldProps = (key, props = {}) => ({ value: form[key], disabled: blocked, onChange: e => updateField(key, e.target.value), ...props })

      function renderMember(group, member) {
        const key = `${group.groupId}|${member.senderId}`
        const open = openMember === key
        const page = messages[key]
        const offset = page?.offset ?? 0
        const goToPage = nextOffset => {
          setEditingMessage('')
          setEditingText('')
          setPendingMessageDelete('')
          void loadMessages(group.groupId, member.senderId, key, nextOffset)
        }
        const memberName = member.senderName || member.senderId.slice(0, 10)
        return h('li', { key: member.senderId },
          h('button', { type: 'button', className: 'gvm-entry', 'aria-expanded': open, onClick: () => toggleMember(group.groupId, member.senderId, key) },
            h('span', { className: 'gvm-name' },
              h('strong', null, memberName),
              h('span', { className: 'gvm-help' }, `${formatCount.format(member.count)} 条 · 向量 ${formatSize(member.vecBytes)}`)),
            h('span', { className: 'gvm-chevron', 'aria-hidden': true }, open ? '▾' : '▸')),
          open ? h('div', { className: 'gvm-member-body' },
            showList(messages[key], () => loadMessages(group.groupId, member.senderId, key), '暂无发言记录。', rows =>
              h('ul', { className: 'gvm-messages', 'aria-label': `${memberName}最近的发言` }, rows.map(message => {
                const messageKey = `${key}|${message.id}`
                const editing = editingMessage === messageKey
                const deleting = pendingMessageDelete === messageKey
                return h('li', { key: message.id },
                  h('time', { className: 'gvm-help' }, timeLabel(message.sentAt)),
                  editing
                    ? h('div', { className: 'gvm-message-edit' },
                        h('textarea', { className: 'gvm-input', value: editingText, maxLength: 10000, disabled: blocked,
                          onChange: event => setEditingText(event.target.value) }),
                        h('div', { className: 'gvm-row' },
                          button(busy === 'message-update' ? '正在保存…' : '保存修改', { 'data-tone': 'primary', disabled: blocked || !editingText.trim(), onClick: () => updateMessage(group.groupId, member.senderId, message, key) }),
                          button('取消', { disabled: blocked, onClick: () => { setEditingMessage(''); setEditingText('') } })))
                    : h('p', null, String(message.text || '').replace(/<@[^>]+>/g, '@某人')),
                  h('div', { className: 'gvm-row gvm-message-actions' },
                    deleting
                      ? h('div', { className: 'gvm-row' },
                          h('span', { className: 'gvm-help' }, '确认删除这条记忆？'),
                          button(busy === 'message-delete' ? '正在删除…' : '确认删除', { 'data-tone': 'danger', disabled: blocked, onClick: () => deleteMessage(group.groupId, member.senderId, message, key, messageKey) }),
                          button('取消', { disabled: blocked, onClick: () => setPendingMessageDelete('') }))
                      : h('div', { className: 'gvm-row' },
                          button('编辑', { disabled: blocked, onClick: () => { setEditingMessage(messageKey); setEditingText(message.text || ''); setPendingMessageDelete('') } }),
                          button('删除', { 'data-tone': 'danger', disabled: blocked, onClick: () => deleteMessage(group.groupId, member.senderId, message, key, messageKey) })))
                )
              }))),
            (offset > 0 || member.count > messagePageSize) && h('div', { className: 'gvm-row', role: 'group', 'aria-label': '记忆分页' },
              button('上一页', { disabled: blocked || page?.loading || offset === 0, onClick: () => goToPage(offset - messagePageSize) }),
              h('span', { className: 'gvm-help' }, `第 ${offset / messagePageSize + 1} 页`),
              button('下一页', { disabled: blocked || page?.loading || offset + messagePageSize >= member.count, onClick: () => goToPage(offset + messagePageSize) })),
            pendingDelete === key
              ? h('div', { className: 'gvm-confirm', role: 'group', 'aria-label': '确认清除成员记忆' },
                  h('p', null, `清除「${memberName}」在「${group.label}」的记忆？`),
                  h('div', { className: 'gvm-row' },
                    button('取消', { disabled: blocked, onClick: () => setPendingDelete('') }),
                    button(busy === 'delete' ? '正在清除…' : '确认清除', { 'data-tone': 'danger', disabled: blocked, onClick: () => deleteMember(group.groupId, member.senderId, key) })))
              : h('div', { className: 'gvm-row' }, button('清除此成员记忆', { 'data-tone': 'danger', disabled: blocked, onClick: () => setPendingDelete(key) }))) : null)
      }

      function renderGroup(group) {
        const { groupId } = group
        const open = openGroup === groupId
        const channel = group.channel === 'qq' ? 'QQ' : group.channel === 'feishu' ? '飞书' : '群聊'
        const name = group.name || group.label
        const draft = groupDrafts[groupId] || {}
        const edit = (key, value) => setGroupDrafts(previous => ({ ...previous, [groupId]: { ...previous[groupId], [key]: value } }))
        const details = [`${formatCount.format(group.people)} 位成员`, `${formatCount.format(group.count)} 条记录`]
        if (group.name && group.qqNumber) details.unshift(`群号 ${group.qqNumber}`)
        const latest = timeLabel(group.latestAt)
        if (latest) details.push(`最近 ${latest}`)
        return h('article', { className: 'gvm-item', key: groupId },
          h('button', { type: 'button', className: 'gvm-entry', 'aria-expanded': open, onClick: () => toggleGroup(groupId) },
            h('span', { className: 'gvm-channel' }, channel),
            h('span', { className: 'gvm-name' }, h('strong', null, name), h('span', { className: 'gvm-help' }, details.join(' · '))),
            h('span', { className: 'gvm-chevron', 'aria-hidden': true }, open ? '▾' : '▸')),
          open ? h('div', { className: 'gvm-group-body' },
            showList(members[groupId], () => loadMembers(groupId), '这个群还没有成员记录。', rows =>
              h('ul', { className: 'gvm-members' }, rows.map(member => renderMember(group, member)))),
            h('details', { className: 'gvm-meta' }, h('summary', null, '编辑群信息'),
              h('div', { className: 'gvm-stack' },
                h('div', { className: 'gvm-fields' },
                  field('显示名称', { value: draft.name ?? group.name ?? '', maxLength: 40, disabled: blocked, onChange: e => edit('name', e.target.value) },
                    group.autoName ? `平台群名：${group.autoName}` : undefined),
                  channel === 'QQ' || group.qqNumber ? field('QQ 群号', {
                    value: draft.qqNumber ?? group.qqNumber ?? '', inputMode: 'numeric', maxLength: 20, disabled: blocked,
                    onChange: e => edit('qqNumber', e.target.value.replace(/\D/g, '')),
                  }) : null),
                h('div', { className: 'gvm-row' }, button(busy === 'group' ? '正在保存…' : '保存群信息', {
                  disabled: blocked || Object.keys(draft).length === 0, onClick: () => saveGroup(groupId, draft),
                }))))) : null)
      }

      const recordsPanel = () => h('div', { className: 'gvm-stack' },
        h('dl', { className: 'gvm-metrics' }, [['收录消息', stats.messages], ['已向量化', stats.embedded], ['收录群聊', groups.length]].map(([label, value]) =>
          h('div', { className: 'gvm-metric', key: label }, h('dt', null, label), h('dd', null, formatCount.format(value || 0))))),
        h('section', { className: 'gvm-card' },
          h('div', { className: 'gvm-row gvm-spread gvm-card-head' },
            h('div', null, h('h3', { className: 'gvm-title' }, '已收录的群'), h('p', { className: 'gvm-help' }, `本地存储 ${formatSize(dbBytes)}`)),
            button(busy === 'sync' ? '正在同步…' : '立即同步', { 'data-tone': 'primary', disabled: blocked, onClick: syncRecords })),
          status('sync', 'delete', 'group', 'message-update', 'message-delete'),
          groups.length ? h('div', { className: 'gvm-list' }, groups.map(renderGroup)) : h('p', { className: 'gvm-empty' }, '还没有收录群聊消息。')))

      const settingsPanel = () => h('form', { className: 'gvm-stack gvm-form', onSubmit: saveSettings },
        h('section', { className: 'gvm-card' },
          h('div', { className: 'gvm-row gvm-spread gvm-card-head' },
            h('div', null, h('h3', { className: 'gvm-title' }, '启用范围'),
              h('p', { className: 'gvm-help' }, selected.length ? `限 ${selected.length} 个工作区 · 自动保存` : '全部工作区 · 自动保存')),
            button(busy === 'workspace-list' ? '正在读取…' : workspacePickerOpen ? '收起列表' : '选择工作区', {
              disabled: blocked, 'aria-expanded': workspacePickerOpen, 'aria-controls': `${id}-workspace-options`, onClick: toggleWorkspacePicker,
            })),
          selected.length ? h('div', { className: 'gvm-list' }, selected.map(path => {
            const title = workspaces.find(item => item.path === path)?.title || path.split(/[\\/]/).filter(Boolean).pop() || path
            return h('div', { key: path, className: 'gvm-selected' },
              h('span', { className: 'gvm-name' }, h('strong', null, title), h('span', { className: 'gvm-help' }, path)),
              button(selected.length === 1 ? '恢复全部启用' : '移除', {
                'data-tone': 'quiet', disabled: blocked, onClick: () => saveWorkspaces(selected.filter(item => item !== path)),
              }))
          })) : h('p', { className: 'gvm-empty' }, '全部工作区已启用。'),
          workspacePickerOpen ? h('div', { id: `${id}-workspace-options`, className: 'gvm-option-list', 'aria-label': 'DSH 工作区' },
            workspaces.length ? workspaces.map(workspace => {
              const chosen = selected.includes(workspace.path)
              return h('button', { key: workspace.id || workspace.path, type: 'button', className: 'gvm-option', disabled: blocked || chosen,
                onClick: () => saveWorkspaces([...selected, workspace.path]) },
              h('span', { className: 'gvm-name' }, h('strong', null, workspace.title || workspace.path), h('span', { className: 'gvm-help' }, workspace.path)),
              h('span', { className: 'gvm-help' }, chosen ? '已启用' : `${workspace.sessionCount} 个会话`))
            }) : h('p', { className: 'gvm-empty' }, 'DSH 中暂无已注册的工作区。')) : null,
          status('workspace-list', 'workspace-save')),
        h('section', { className: 'gvm-card' },
          h('div', { className: 'gvm-row gvm-spread gvm-card-head' }, h('h3', { className: 'gvm-title' }, '向量模型'),
            button(busy === 'test' ? '正在测试…' : '测试连接', { title: '测试已保存的模型配置', disabled: blocked,
              onClick: () => act('test', async () => {
                const value = await callRpc(rpc, 'test')
                return `已保存的配置连接正常 · ${value.dims} 维 · ${value.ms} ms`
              }),
            })),
          field('接口地址', fieldProps('baseUrl', { inputMode: 'url', spellCheck: false, placeholder: 'https://api.siliconflow.cn/v1' })),
          h('div', { className: 'gvm-fields' },
            field('模型名', fieldProps('model', { spellCheck: false, placeholder: 'BAAI/bge-m3' })),
            field('API Key', fieldProps('apiKey', { type: 'password', autoComplete: 'off', placeholder: config.embedding.apiKeyMasked || '输入密钥' }),
              config.embedding.apiKeySet ? '已配置，留空保留原密钥。' : undefined)),
          status('test')),
        h('section', { className: 'gvm-card' },
          h('div', { className: 'gvm-row gvm-spread gvm-card-head' }, h('h3', { className: 'gvm-title' }, '召回设置'),
            button(busy === 'preview' ? '正在生成…' : '预览召回', { disabled: blocked, onClick: previewRecall })),
          h('div', { className: 'gvm-fields' },
            field('近期发言条数', fieldProps('recent', { type: 'number', min: 0, max: 50, required: true })),
            field('语义召回条数', fieldProps('semantic', { type: 'number', min: 0, max: 50, required: true })),
            field('最低相似度', fieldProps('minScore', { type: 'number', min: 0, max: 1, step: 'any', required: true }))),
          status('preview'),
          preview !== null ? h('div', { className: 'gvm-stack' },
            h('div', { className: 'gvm-row gvm-spread' }, h('strong', null, '召回结果'), button('关闭预览', { 'data-tone': 'quiet', onClick: () => setPreview(null) })),
            h('pre', { className: 'gvm-preview', tabIndex: 0 }, preview)) : null),
        h('section', { className: 'gvm-card' },
          h('label', { className: 'gvm-check' },
            h('input', { type: 'checkbox', checked: form.debug, disabled: blocked, onChange: e => updateField('debug', e.target.checked) }),
            '调试日志'),
          h('p', { className: 'gvm-help' }, '排查群聊记忆问题时开启。'),
          status('save'),
          h('div', { className: 'gvm-footer gvm-row' },
            dirty ? h('span', { className: 'gvm-help' }, '有未保存的修改') : null,
            button(busy === 'save' ? '正在保存…' : '保存设置', { type: 'submit', 'data-tone': 'primary', disabled: blocked || !dirty }))))

      return h('div', { className: 'gvm-settings' }, h('style', null, styles),
        h('header', { className: 'gvm-row gvm-spread' },
          h('h2', { className: 'gvm-heading' }, '群聊记忆'),
          h('span', { className: 'gvm-source', 'data-available': available }, available ? 'IM 历史库可用' : 'IM 历史库不可用')),
        h('div', { className: 'gvm-tabs', role: 'tablist', 'aria-label': '群聊记忆页面' }, tabs.map(([key, label], index) =>
          h('button', { key, id: `${id}-${key}`, className: 'gvm-tab', type: 'button', role: 'tab',
            'aria-selected': tab === key, 'aria-controls': `${id}-panel`, tabIndex: tab === key ? 0 : -1, onClick: () => setTab(key),
            onKeyDown: event => {
              const indices = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 }
              if (!Object.hasOwn(indices, event.key)) return
              event.preventDefault()
              const nextIndex = (indices[event.key] + tabs.length) % tabs.length
              setTab(tabs[nextIndex][0])
              event.currentTarget.parentElement.children[nextIndex]?.focus()
            },
          }, label))),
        h('div', { id: `${id}-panel`, role: 'tabpanel', 'aria-labelledby': `${id}-${tab}` }, tab === 'records' ? recordsPanel() : settingsPanel()))
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'group-vector-memory',
          order: 36,
          label: () => '群聊记忆',
          inject: () => ({ rpc: ctx.connection.rpc }),
        }, GroupMemorySettings))
      },
    }
  },
})
