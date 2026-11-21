import { compareArrival, normalizeArrival } from './dshim.js'

const CURSOR_KEY = 'chat_archive_cursor_v1'
const MAX_LIMIT = 30
const MAX_TEXT = 4000
const MAX_BYTES = 20000
const asciiLower = value => value.replace(/[A-Z]/g, char => char.toLowerCase())

export const archiveParameters = {
  person: { type: 'string', description: '发言人的 ID 或昵称片段。省略时查所有发言人。' },
  keyword: { type: 'string', description: '正文中包含的原词或短语。' },
  from: { type: 'string', description: '开始日期，YYYY-MM-DD，包含当天。按 DSH 的本地时区。' },
  to: { type: 'string', description: '结束日期，YYYY-MM-DD，包含当天。按 DSH 的本地时区。' },
  speaker: { type: 'string', enum: ['all', 'self', 'others'], description: 'self 查当前机器人发出的消息，others 查收到的消息，默认 all。' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '每页条数，默认 10。' },
  cursor: { type: 'string', description: '保持筛选条件不变，传上一页的 nextCursor 读取更早的结果。' },
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/
const legacyTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

function dateBound(value, endOfDay = false) {
  if (value === undefined) return null
  if (typeof value !== 'string' || (!datePattern.test(value) && !legacyTimestamp.test(value))) {
    throw new TypeError('请输入 YYYY-MM-DD 格式的日期。')
  }
  const day = value.slice(0, 10)
  const utc = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(utc.getTime()) || !utc.toISOString().startsWith(`${day}T`)) throw new TypeError('日期无效。')
  // Accept timestamps from older callers. Date-only filters use the DSH host's calendar day.
  if (value !== day) {
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || value.slice(11, 13) === '24') throw new TypeError('日期无效。')
    return ms
  }
  const local = new Date(`${day}T00:00:00`)
  if (!endOfDay) return local.getTime()
  // Set the following calendar day rather than adding 24 hours across a DST transition.
  local.setFullYear(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate() + 1)
  local.setHours(0, 0, 0, 0)
  return local.getTime() - 1
}

function localDate(timestamp) {
  const date = new Date(timestamp)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function pageToken(input, groupId, last) {
  return Buffer.from(JSON.stringify([groupId, last.sent_at, last.id, input])).toString('base64url')
}

function pageStart(cursor, groupId, input) {
  if (cursor === undefined) return null
  try {
    if (typeof cursor !== 'string' || cursor.length > 10000) throw new Error()
    const [group, time, id, filters] = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (group !== groupId || !Number.isSafeInteger(time) || typeof id !== 'string' ||
        JSON.stringify(filters) !== JSON.stringify(input)) throw new Error()
    return { time, id }
  } catch {
    throw new TypeError('分页游标无效。请用当前筛选条件重新查询。')
  }
}

export function createArchiveStore(db, transaction) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_archive (
      group_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      has_attachments INTEGER NOT NULL,
      PRIMARY KEY (group_id, id)
    );
    CREATE INDEX IF NOT EXISTS chat_archive_timeline ON chat_archive(group_id, sent_at DESC, id DESC);
  `)
  const getCursor = db.prepare('SELECT value FROM meta WHERE key = ?')
  const setCursor = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  const insert = db.prepare(`INSERT INTO chat_archive (group_id, id, sender_id, sender_name, text, sent_at, direction, has_attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, id) DO NOTHING`)
  const listGroups = db.prepare('SELECT DISTINCT group_id FROM chat_archive')

  function cursor() {
    const value = getCursor.get(CURSOR_KEY)?.value
    return value === undefined ? 0 : normalizeArrival(JSON.parse(value))
  }

  return {
    cursor,
    groups: () => listGroups.all().map(row => row.group_id),
    copy(rows) {
      if (!rows.length) return 0
      return transaction(() => {
        let added = 0
        let through = cursor()
        for (const row of rows) {
          const arrival = normalizeArrival(row.sourceSeq)
          if (compareArrival(arrival, through) > 0) through = arrival
          added += Number(insert.run(row.groupId, row.sourceId, row.senderId, row.senderName, row.text,
            row.sentAt, row.direction, Number(row.hasAttachments)).changes)
        }
        setCursor.run(CURSOR_KEY, JSON.stringify(through))
        return added
      })
    },
    query(groupId, { person = '', keyword = '', speaker = 'all', from, to, cursor, limit = 10 } = {}) {
      if (typeof groupId !== 'string' || !groupId.trim()) throw new TypeError('请选择一个群。')
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TypeError('每页条数须为 1–30。')
      if (!['all', 'self', 'others'].includes(speaker)) throw new TypeError('发言人类型无效。')
      if (typeof person !== 'string' || person.length > 200 || typeof keyword !== 'string' || keyword.length > 300) {
        throw new TypeError('发言人或关键词无效。')
      }
      person = person.trim()
      keyword = keyword.trim()
      const start = dateBound(from)
      const end = dateBound(to, true)
      if (start !== null && end !== null && start > end) throw new TypeError('开始日期须早于或等于结束日期。')
      const filters = [person, keyword, speaker, start, end]
      const after = pageStart(cursor, groupId, filters)
      const conditions = ['group_id = ?']
      const args = [groupId]
      if (person) {
        conditions.push('(sender_id = ? OR instr(lower(sender_name), lower(?)) > 0)')
        args.push(person, person)
      }
      if (keyword) {
        conditions.push('instr(lower(text), lower(?)) > 0')
        args.push(keyword)
      }
      if (speaker !== 'all') {
        conditions.push('direction = ?')
        args.push(speaker === 'self' ? 'outbound' : 'inbound')
      }
      if (start !== null) {
        conditions.push('sent_at >= ?')
        args.push(start)
      }
      if (end !== null) {
        conditions.push('sent_at <= ?')
        args.push(end)
      }
      if (after) {
        conditions.push('(sent_at, id) < (?, ?)')
        args.push(after.time, after.id)
      }
      const rows = db.prepare(`SELECT * FROM chat_archive WHERE ${conditions.join(' AND ')}
        ORDER BY sent_at DESC, id DESC LIMIT ?`).all(...args, limit + 1)
      const items = []
      let bytes = 0
      for (const row of rows.slice(0, limit)) {
        // SQLite lower() folds ASCII only. Use the same match when showing a long message.
        const hit = keyword ? asciiLower(row.text).indexOf(asciiLower(keyword)) : 0
        const item = { id: row.id, senderId: row.sender_id, senderName: row.sender_name, date: localDate(row.sent_at), sentAt: row.sent_at,
          direction: row.direction, hasAttachments: Boolean(row.has_attachments) }
        const excerpt = length => {
          const offset = Math.max(0, hit - Math.floor(length / 4))
          item.text = row.text.slice(offset, offset + length)
          item.textTruncated = item.text.length < row.text.length
          return Buffer.byteLength(JSON.stringify(item))
        }
        let length = MAX_TEXT
        let size = excerpt(length)
        if (items.length && bytes + size > MAX_BYTES) break
        while (size > MAX_BYTES && length > 500) {
          length = Math.floor(length / 2)
          size = excerpt(length)
        }
        items.push(item)
        bytes += size
      }
      return {
        items,
        nextCursor: items.length && items.length < rows.length ? pageToken(filters, groupId, rows[items.length - 1]) : null,
      }
    },
  }
}
