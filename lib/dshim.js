import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultImPath() {
  return join(homedir(), '.dsh', 'integrations', 'dsh-im', 'group-history.sqlite')
}

/** 只读打开 dsh-im 的群历史库，增量取新消息。 */
export function createImReader(dbPath = defaultImPath()) {
  let db = null
  function open() {
    if (db) return db
    if (!existsSync(dbPath)) throw new Error(`找不到 dsh-im 群历史库：${dbPath}`)
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db
  }
  const stLast = () => open().prepare('SELECT MAX(sent_at) AS t FROM messages')
  const stAfter = () => open().prepare(`
    SELECT m.id, m.group_id, m.platform_message_id, m.sender_id, m.sender_name, m.text, m.sent_at
    FROM messages m WHERE m.sent_at >= ? ORDER BY m.sent_at ASC LIMIT ?
  `)
  const stGroups = () => open().prepare('SELECT id, channel, platform_group_id, name FROM groups')

  return {
    path: dbPath,
    available() {
      try { open(); return true } catch { return false }
    },
    groups() {
      try { return stGroups().all() } catch { return [] }
    },
    since(lastSentAt = 0, limit = 500) {
      const rows = stAfter().all(lastSentAt, limit)
      return rows.map((r, i) => ({
        // platform_message_id 缺失时用 sent_at+sender 兜底，避免多条消息共用一个 id 被覆盖
        id: r.platform_message_id ? `${r.group_id}:${r.platform_message_id}` : `${r.group_id}:fallback:${r.sent_at}:${r.sender_id}:${i}`,
        groupId: r.group_id,
        senderId: r.sender_id,
        senderName: r.sender_name || '',
        text: String(r.text || ''),
        sentAt: Number(r.sent_at) || 0,
      }))
    },
    latestSentAt() {
      try { return Number(stLast().get()?.t) || 0 } catch { return 0 }
    },
    close() {
      try { db?.close() } catch {}
      db = null
    },
  }
}
