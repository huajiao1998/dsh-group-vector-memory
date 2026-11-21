import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function defaultImPath() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-im', 'group-history.sqlite')
}

export function normalizeArrival(cursor) {
  if (cursor === 0) return { receivedAt: 0, rowid: 0 }
  if (Number.isSafeInteger(cursor?.receivedAt) && cursor.receivedAt >= 0 &&
      Number.isSafeInteger(cursor.rowid) && cursor.rowid > 0) return cursor
  throw new TypeError('无效的 IM 接收游标')
}

export function compareArrival(a, b) {
  const left = normalizeArrival(a)
  const right = normalizeArrival(b)
  return left.receivedAt - right.receivedAt || left.rowid - right.rowid
}

/** 只读打开 dsh-im 的群历史库，增量取新消息。 */
export function createImReader(dbPath = defaultImPath()) {
  let db = null
  let statements = null
  let emptyRead = null
  function open() {
    if (db) return db
    if (!existsSync(dbPath)) throw new Error(`找不到 dsh-im 群历史库：${dbPath}`)
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 3000')
    return db
  }
  function messageStatements() {
    if (statements) return statements
    const db = open()
    const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(col => col.name))
    const hasReceivedAt = messageColumns.has('received_at')
    const type = messageColumns.has('type') ? 'm.type' : "'text'"
    const hasChannel = db.prepare('PRAGMA table_info(groups)').all().some(col => col.name === 'channel')
    const hasAttachments = db.prepare('PRAGMA table_info(attachments)').all().some(col => col.name === 'message_id')
    // 安装版没有 AUTOINCREMENT；过期清理扫空后 rowid 会重用，不能单独做永久游标。
    // 旧来源表没有接收时间时仍可按 rowid 增量，但没有这个重用保护。
    const received = hasReceivedAt ? 'm.received_at' : '0'
    const channel = hasChannel ? '(SELECT g.channel FROM groups g WHERE g.id = m.group_id)' : "''"
    const attachments = hasAttachments ? 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)' : '0'
    const projection = `m.id, m.group_id, m.platform_message_id, m.sender_id, m.sender_name, m.text,
      m.sent_at, ${received} AS received_at, m.rowid AS arrival_rowid,
      ${channel} AS channel, ${attachments} AS has_attachments, ${type} AS message_type`
    return (statements = {
      hasReceivedAt,
      old: db.prepare(`SELECT ${projection} FROM messages m
        WHERE (m.sent_at > ?) OR (m.sent_at = ? AND m.id > ?)
        ORDER BY m.sent_at, m.id LIMIT ?`),
      after: db.prepare(`SELECT ${projection} FROM messages m
        WHERE ${hasReceivedAt ? '(m.received_at, m.rowid) > (?, ?)' : 'm.rowid > ?'}
        ORDER BY ${hasReceivedAt ? 'm.received_at, ' : ''}m.rowid LIMIT ?`),
      latest: db.prepare(`SELECT ${received} AS received_at, m.rowid AS arrival_rowid FROM messages m
        ORDER BY ${hasReceivedAt ? 'm.received_at DESC, ' : ''}m.rowid DESC LIMIT 1`),
      version: db.prepare('PRAGMA data_version'),
    })
  }
  const sourceSeq = r => ({ receivedAt: Number(r.received_at), rowid: Number(r.arrival_rowid) })
  const mapRow = r => ({
    id: r.platform_message_id ? `${r.group_id}:${r.platform_message_id}` : `${r.group_id}:source:${r.id}`,
    sourceId: String(r.id),
    sourceSeq: sourceSeq(r),
    groupId: r.group_id,
    senderId: r.sender_id,
    senderName: r.sender_name || '',
    text: String(r.text || ''),
    sentAt: Number(r.sent_at) || 0,
    channel: r.channel || '',
    hasAttachments: Boolean(r.has_attachments),
    direction: r.message_type === 'outbound-text' ? 'outbound' : 'inbound',
  })

  return {
    path: dbPath,
    available() {
      try { open(); return true } catch { return false }
    },
    groups() {
      try { return open().prepare('SELECT id, channel, platform_group_id, name FROM groups').all() } catch { return [] }
    },
    since(cursor = 0, limit = 500) {
      const normalized = typeof cursor === 'object' && cursor !== null
        ? { sentAt: Number(cursor.sentAt) || 0, sourceId: String(cursor.sourceId || '') }
        : { sentAt: Number(cursor) || 0, sourceId: '' }
      return messageStatements().old.all(normalized.sentAt, normalized.sentAt, normalized.sourceId, limit).map(mapRow)
    },
    sinceArrival(cursor = 0, limit = 500) {
      const after = normalizeArrival(cursor)
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('IM 批次大小必须是正整数')
      const stmt = messageStatements()
      // 接收时间在源库没有索引；源未变更时，不必每次 watcher 轮询重扫尾部。
      const version = stmt.version.get().data_version
      if (emptyRead?.version === version && compareArrival(emptyRead.cursor, cursor) === 0) return []
      const rows = stmt.hasReceivedAt
        ? stmt.after.all(after.receivedAt, after.rowid, limit)
        : stmt.after.all(after.rowid, limit)
      emptyRead = rows.length ? null : { version, cursor }
      return rows.map(mapRow)
    },
    latestArrival(floor = 0) {
      const row = messageStatements().latest.get()
      const cursor = row ? sourceSeq(row) : 0
      return compareArrival(cursor, floor) > 0 ? cursor : floor
    },
    latestSentAt() {
      try { return Number(open().prepare('SELECT MAX(sent_at) AS t FROM messages').get()?.t) || 0 } catch { return 0 }
    },
    close() {
      try { db?.close() } catch {}
      db = null
      statements = null
      emptyRead = null
    },
  }
}
