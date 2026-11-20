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
    FROM messages m
    WHERE (m.sent_at > ?) OR (m.sent_at = ? AND m.id > ?)
    ORDER BY m.sent_at ASC, m.id ASC LIMIT ?
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
    since(cursor = 0, limit = 500) {
      const normalized = typeof cursor === 'object' && cursor !== null
        ? { sentAt: Number(cursor.sentAt) || 0, sourceId: String(cursor.sourceId || '') }
        : { sentAt: Number(cursor) || 0, sourceId: '' }
      const rows = stAfter().all(normalized.sentAt, normalized.sentAt, normalized.sourceId, limit)
      return rows.map(r => ({
        // platform_message_id 缺失时使用 dsh-im 的稳定主键，跨轮查询仍能命中同一条消息。
        id: r.platform_message_id ? `${r.group_id}:${r.platform_message_id}` : `${r.group_id}:source:${r.id}`,
        sourceId: String(r.id),
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
