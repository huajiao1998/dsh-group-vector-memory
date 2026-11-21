import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { compareArrival, normalizeArrival } from './dshim.js'
import { isMemoryBody } from './memory-body.js'
import { createArchiveStore } from './archive.js'

const ARRIVAL_META_KEY = 'last_arrival_cursor_v1'
const messageView = row => ({ ...row, sentAt: Number(row.sent_at) || 0, groupId: row.group_id })

function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}
function blobToVec(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  // SQLite 返回的 Buffer 可能未按 4 字节对齐，直接包 Float32Array 会抛错；复制到独立 ArrayBuffer
  const copy = new ArrayBuffer(buf.byteLength)
  new Uint8Array(copy).set(buf)
  return new Float32Array(copy)
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, 'memory.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      embedding BLOB,
      embedded_at INTEGER,
      embedding_space TEXT,
      source_received_at INTEGER,
      source_rowid INTEGER
    );
    CREATE TABLE IF NOT EXISTS member_clear_watermarks (
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      source_rowid INTEGER NOT NULL,
      PRIMARY KEY (group_id, sender_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_source_aliases (
      source_key TEXT PRIMARY KEY,
      legacy_id TEXT NOT NULL UNIQUE
    );
    -- 本地编辑/删除必须跨过下一轮只读 IM 同步继续生效。
    CREATE TABLE IF NOT EXISTS message_overrides (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      text TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, sent_at DESC);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT '',
      platform_group_id TEXT NOT NULL DEFAULT '',
      qq_number TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      auto_name TEXT NOT NULL DEFAULT '',
      synced_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS profiles (
      sender_id TEXT PRIMARY KEY,
      sender_name TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `)

  // 旧表通过加列升级，不重建消息，不覆盖编辑、删除或已保存向量。
  const messageCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name))
  for (const [column, type] of [['embedding_space', 'TEXT'], ['source_received_at', 'INTEGER'], ['source_rowid', 'INTEGER'],
    ['source_channel', 'TEXT'], ['source_has_attachments', 'INTEGER']]) {
    if (!messageCols.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${type}`)
  }
  const groupColumns = db.prepare('PRAGMA table_info(groups)').all()
  if (!groupColumns.some(column => column.name === 'source_name')) {
    db.exec("ALTER TABLE groups ADD COLUMN source_name TEXT NOT NULL DEFAULT ''")
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_group_sender ON messages(group_id, sender_id, sent_at DESC)')
  db.function('gvm_memory_body', { deterministic: true }, (text, channel, hasAttachments) => Number(isMemoryBody(text, channel, hasAttachments)))
  const stGroupChannel = db.prepare('SELECT channel FROM groups WHERE group_id = ?')
  const eligible = `gvm_memory_body(text, coalesce(source_channel,
    (SELECT channel FROM groups WHERE groups.group_id = messages.group_id)), source_has_attachments) = 1`
  const sourceChannel = row => row.channel || null
  const sourceAttachments = row => typeof row.hasAttachments === 'boolean' ? Number(row.hasAttachments)
    : Array.isArray(row.attachments) ? Number(row.attachments.length > 0) : null
  const stUpsert = db.prepare(`
    INSERT INTO messages (id, group_id, sender_id, sender_name, text, sent_at, source_received_at, source_rowid,
                          source_channel, source_has_attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sender_name = excluded.sender_name,
      text = excluded.text,
      source_received_at = coalesce(excluded.source_received_at, messages.source_received_at),
      source_rowid = coalesce(excluded.source_rowid, messages.source_rowid),
      source_channel = coalesce(excluded.source_channel, messages.source_channel),
      source_has_attachments = coalesce(excluded.source_has_attachments, messages.source_has_attachments),
      embedding = CASE WHEN messages.text = excluded.text THEN messages.embedding ELSE NULL END,
      embedded_at = CASE WHEN messages.text = excluded.text THEN messages.embedded_at ELSE NULL END,
      embedding_space = CASE WHEN messages.text = excluded.text THEN messages.embedding_space ELSE NULL END
    WHERE (excluded.source_received_at IS NULL OR messages.source_received_at IS NULL OR
           (excluded.source_received_at, excluded.source_rowid) >= (messages.source_received_at, messages.source_rowid))
      AND (messages.sender_name IS NOT excluded.sender_name OR messages.text IS NOT excluded.text OR
           (excluded.source_channel IS NOT NULL AND messages.source_channel IS NOT excluded.source_channel) OR
           (excluded.source_has_attachments IS NOT NULL AND messages.source_has_attachments IS NOT excluded.source_has_attachments) OR
           (excluded.source_received_at IS NOT NULL AND
            (messages.source_received_at IS NOT excluded.source_received_at OR messages.source_rowid IS NOT excluded.source_rowid)))
  `)
  const stWatermark = db.prepare('SELECT received_at AS receivedAt, source_rowid AS rowid FROM member_clear_watermarks WHERE group_id = ? AND sender_id = ?')
  const stSetWatermark = db.prepare(`
    INSERT INTO member_clear_watermarks VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, sender_id) DO UPDATE SET received_at = excluded.received_at, source_rowid = excluded.source_rowid
    WHERE (excluded.received_at, excluded.source_rowid) > (member_clear_watermarks.received_at, member_clear_watermarks.source_rowid)
  `)
  const stAlias = db.prepare('SELECT legacy_id FROM legacy_source_aliases WHERE source_key = ?')
  const stSetAlias = db.prepare('INSERT INTO legacy_source_aliases VALUES (?, ?)')
  const stExists = db.prepare('SELECT 1 FROM messages WHERE id = ?')
  const stLegacy = db.prepare(`
    SELECT m.id, m.text, o.action, o.updated_at FROM messages m LEFT JOIN message_overrides o ON o.id = m.id
    WHERE m.id >= ? AND m.id < ? AND NOT EXISTS(SELECT 1 FROM legacy_source_aliases a WHERE a.legacy_id = m.id)
    UNION ALL
    SELECT o.id, NULL AS text, o.action, o.updated_at FROM message_overrides o
    WHERE o.id >= ? AND o.id < ? AND o.action = 'delete'
      AND NOT EXISTS(SELECT 1 FROM legacy_source_aliases a WHERE a.legacy_id = o.id)
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id = o.id)
  `)
  // 老库升级：早期版本的 groups 表没有 auto_name，补上（建表语句的 IF NOT EXISTS 不会改旧表）
  try {
    const cols = db.prepare('PRAGMA table_info(groups)').all().map(c => c.name)
    if (cols.length && !cols.includes('auto_name')) db.exec("ALTER TABLE groups ADD COLUMN auto_name TEXT NOT NULL DEFAULT ''")
  } catch {}
  const activeEmbedding = 'embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?)'
  let currentSpace = null
  const stSetEmbedding = db.prepare(`UPDATE messages SET embedding = ?, embedded_at = ?, embedding_space = ?
    WHERE id = ? AND (? IS NULL OR text = ?) AND (${activeEmbedding}) IS NOT TRUE AND ${eligible}`)
  const stOverride = db.prepare('SELECT action, text FROM message_overrides WHERE id = ?')
  const stSetOverride = db.prepare(`
    INSERT INTO message_overrides (id, action, text, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET action = excluded.action, text = excluded.text, updated_at = excluded.updated_at
  `)
  const pendingProjection = 'SELECT id, text, sent_at AS sentAt FROM messages'
  const stMissing = db.prepare(`${pendingProjection} WHERE (${activeEmbedding}) IS NOT TRUE AND ${eligible} ORDER BY sent_at ASC, id ASC LIMIT ?`)
  const stMissingAfter = db.prepare(`${pendingProjection} WHERE (sent_at, id) > (?, ?) AND (${activeEmbedding}) IS NOT TRUE AND ${eligible} ORDER BY sent_at ASC, id ASC LIMIT ?`)
  const stNeedsEmbedding = db.prepare(`SELECT 1 FROM messages WHERE id = ? AND text = ? AND (${activeEmbedding}) IS NOT TRUE AND ${eligible}`)
  const stRecent = scoped => db.prepare(`SELECT id, text, sent_at, group_id FROM messages WHERE sender_id = ?${scoped ? ' AND group_id = ?' : ''} AND ${eligible} ORDER BY sent_at DESC, id DESC LIMIT ?`)
  const stVectors = scoped => db.prepare(`SELECT id, sender_id, text, sent_at, group_id, embedding FROM messages WHERE sender_id = ?${scoped ? ' AND group_id = ?' : ''} AND ${activeEmbedding} AND ${eligible} ORDER BY sent_at DESC, id DESC LIMIT ?`)
  const recent = [stRecent(false), stRecent(true)]
  const vectors = [stVectors(false), stVectors(true)]
  const stCount = db.prepare('SELECT COUNT(*) AS n FROM messages')
  const stCountEmbedded = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${activeEmbedding}`)
  const stEmbeddingCounts = db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN ${activeEmbedding} THEN 1 END) AS embedded
    FROM messages WHERE ${eligible}`)
  const stBySender = db.prepare('SELECT sender_id, sender_name, COUNT(*) AS n FROM messages GROUP BY sender_id ORDER BY n DESC LIMIT ?')
  const stMetaGet = db.prepare('SELECT value FROM meta WHERE key = ?')
  const stMetaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const stProfile = db.prepare('SELECT * FROM profiles WHERE sender_id = ?')
  const stSetProfile = db.prepare(`
    INSERT INTO profiles (sender_id, sender_name, profile, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(sender_id) DO UPDATE SET sender_name = excluded.sender_name, profile = excluded.profile, updated_at = excluded.updated_at
  `)

  function getSyncCursor() {
    // 旧 sent_at 游标无法推断接收进度：保留旧库数据及 override，从源头可重入地回放。
    const value = stMetaGet.get(ARRIVAL_META_KEY)?.value
    if (value === undefined) return 0
    const cursor = JSON.parse(value)
    normalizeArrival(cursor)
    return cursor
  }
  function resolveMessageId(row, allowLegacyGuess) {
    // 最早版本的 fallback:<sent_at>:<sender>:<页内下标> 没有稳定源 ID。
    // 只在无平台 ID 的档案行上匹配旧键；已匹配的旧键不能被另一源行复用。
    if (!row.sourceId || row.id !== `${row.groupId}:source:${row.sourceId}`) return row.id
    const mapped = stAlias.get(row.id)
    if (mapped) return mapped.legacy_id
    if (!allowLegacyGuess || stExists.get(row.id) || stOverride.get(row.id)) return row.id
    const base = `${row.groupId}:fallback:${row.sentAt}:${row.senderId}`
    const prefix = `${base}:`
    const candidates = stLegacy.all(prefix, `${base};`, prefix, `${base};`)
      .filter(item => /^\d+$/.test(item.id.slice(prefix.length)) &&
        (item.updated_at == null || !(row.sourceSeq?.receivedAt > item.updated_at)))
      .sort((a, b) => Number(a.id.slice(prefix.length)) - Number(b.id.slice(prefix.length)))
    // 原文相同优先。旧删除记录没有原文，旧编辑只存新文：只能按页内顺序配对。
    const legacy = candidates.find(item => !item.action && item.text === row.text)
      ?? candidates.find(item => item.action === 'delete')
      ?? candidates.find(item => item.action === 'edit')
    if (!legacy) return row.id
    stSetAlias.run(row.id, legacy.id)
    return legacy.id
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    path,
    archive: createArchiveStore(db, transaction),
    getSyncCursor,
    upsertMessages(rows, through) {
      if (through !== undefined) normalizeArrival(through)
      return transaction(() => {
        let added = 0
        for (const r of rows) {
          const seq = r.sourceSeq == null ? null : normalizeArrival(r.sourceSeq)
          if ((r.sourceSeq === 0) || (through !== undefined && (!seq || compareArrival(seq, through) > 0))) {
            throw new RangeError('IM 消息接收游标超出批次范围')
          }
          if (r.direction === 'outbound') continue
          const clearedThrough = seq && stWatermark.get(r.groupId, r.senderId)
          if (clearedThrough && compareArrival(seq, clearedThrough) <= 0) continue
          const id = resolveMessageId(r, !clearedThrough)
          const override = stOverride.get(id)
          if (override?.action === 'delete') continue
          const text = override?.action === 'edit' && typeof override.text === 'string' ? override.text : r.text
          const channel = sourceChannel(r)
          const hasAttachments = sourceAttachments(r)
          if (typeof text === 'string' && !hasAttachments &&
              !isMemoryBody(text, channel ?? stGroupChannel.get(r.groupId)?.channel, false)) continue
          const result = stUpsert.run(id, r.groupId, r.senderId, r.senderName || '', text, r.sentAt,
            seq?.receivedAt ?? null, seq?.rowid ?? null, channel, hasAttachments)
          added += Number(result.changes)
        }
        if (through !== undefined && compareArrival(through, getSyncCursor()) > 0) stMetaSet.run(ARRIVAL_META_KEY, JSON.stringify(through))
        return added
      })
    },
    textForPrewarm(row) {
      if (row.direction === 'outbound') return ''
      const seq = normalizeArrival(row.sourceSeq)
      const cleared = stWatermark.get(row.groupId, row.senderId)
      if (cleared && compareArrival(seq, cleared) <= 0) return ''
      const override = stOverride.get(resolveMessageId(row, false))
      if (override?.action === 'delete') return ''
      const text = override?.action === 'edit' ? override.text : row.text
      const channel = sourceChannel(row) ?? stGroupChannel.get(row.groupId)?.channel
      return isMemoryBody(text, channel, sourceAttachments(row)) ? text : ''
    },
    useEmbeddingSpace(space) {
      currentSpace = space == null ? null : String(space)
    },
    pendingEmbeddings(limit = 50, after = null) {
      return after
        ? stMissingAfter.all(after.sentAt, after.id, currentSpace, currentSpace, limit)
        : stMissing.all(currentSpace, currentSpace, limit)
    },
    needsEmbedding(id, text) {
      return Boolean(stNeedsEmbedding.get(id, text, currentSpace, currentSpace))
    },
    embeddingCounts() {
      const { total, embedded } = stEmbeddingCounts.get(currentSpace, currentSpace)
      return { total, embedded }
    },
    /** 原文和向量空间均须仍匹配，避免异步结果污染新文本或新空间。 */
    setEmbedding(id, vec, expectedText = null, space = currentSpace) {
      if (space !== currentSpace) return 0
      const text = expectedText == null ? null : String(expectedText)
      const result = stSetEmbedding.run(vecToBlob(vec), Date.now(), space, id, text, text, space, space)
      return Number(result.changes)
    },
    recentBySender(senderId, limit, groupId) {
      const scope = groupId == null ? [] : [String(groupId)]
      return recent[scope.length].all(senderId, ...scope, limit).map(messageView)
    },
    vectorsBySender(senderId, limit = 2000, groupId) {
      const scope = groupId == null ? [] : [String(groupId)]
      return vectors[scope.length].all(senderId, ...scope, currentSpace, currentSpace, limit)
        .map(row => ({ ...messageView(row), vector: blobToVec(row.embedding) }))
    },
    stats() {
      return {
        messages: stCount.get().n,
        embedded: stCountEmbedded.get(currentSpace, currentSpace).n,
        senders: stBySender.all(50),
      }
    },
    /** 按群统计：哪个群、多少条、几个人、最新时间、占用 */
    groups() {
      return db.prepare(`
        SELECT group_id, COUNT(*) AS n, COUNT(DISTINCT sender_id) AS people,
               MAX(sent_at) AS latest, SUM(LENGTH(text)) AS chars,
               SUM(CASE WHEN ${activeEmbedding} THEN LENGTH(embedding) ELSE 0 END) AS vec_bytes
        FROM messages GROUP BY group_id ORDER BY latest DESC
      `).all(currentSpace, currentSpace).map(r => ({
        groupId: r.group_id,
        count: Number(r.n) || 0,
        people: Number(r.people) || 0,
        latestAt: Number(r.latest) || 0,
        chars: Number(r.chars) || 0,
        vecBytes: Number(r.vec_bytes) || 0,
      }))
    },
    /** 按人统计（可按群过滤）：谁、多少条、最新时间、文本总字数、向量占多少字节 */
    /** IM 库同步过来的群基本信息；人工填的 name/qq_number 不动 */
    upsertGroups(rows) {
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return 0
      const now = Date.now()
      const stmt = db.prepare(`
        INSERT INTO groups (group_id, channel, platform_group_id, synced_at, source_name)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          channel = excluded.channel,
          platform_group_id = excluded.platform_group_id,
          synced_at = excluded.synced_at,
          source_name = excluded.source_name
      `)
      let n = 0
      for (const r of list) {
        const gid = String(r?.id || r?.groupId || '')
        if (!gid) continue
        try {
          stmt.run(gid, String(r?.channel || ''), String(r?.platform_group_id || r?.platformGroupId || ''), now, String(r?.name || ''))
          n += 1
        } catch {}
      }
      return n
    },
    /** 全部群信息（含人工填的名字和群号） */
    groupInfo() {
      return db.prepare(`SELECT group_id, channel, platform_group_id, qq_number, name, auto_name, source_name FROM groups ORDER BY group_id`).all()
        .map(r => ({
          groupId: r.group_id,
          channel: r.channel,
          platformGroupId: r.platform_group_id,
          qqNumber: r.qq_number,
          name: r.name,
          autoName: r.auto_name || r.source_name,
        }))
    },
    /** QQ 接口拉到的群名（人工填的 name 优先级更高） */
    setGroupAutoName(platformGroupId, autoName) {
      const pid = String(platformGroupId || '')
      const name = String(autoName || '')
      if (!pid || !name) return 0
      db.prepare('UPDATE groups SET auto_name = ? WHERE platform_group_id = ?').run(name, pid)
      return 1
    },
    /** 人工设置群名 / 群号 */
    setGroupInfo(groupId, patch = {}) {
      const gid = String(groupId || '')
      if (!gid) return false
      const row = db.prepare('SELECT group_id FROM groups WHERE group_id = ?').get(gid)
      const name = patch.name === undefined ? undefined : String(patch.name)
      const qq = patch.qqNumber === undefined && patch.qq_number === undefined
        ? undefined
        : String(patch.qqNumber ?? patch.qq_number)
      if (row === undefined) {
        db.prepare('INSERT INTO groups (group_id, name, qq_number, synced_at) VALUES (?, ?, ?, ?)')
          .run(gid, name ?? '', qq ?? '', 0)
        return true
      }
      if (name !== undefined) db.prepare('UPDATE groups SET name = ? WHERE group_id = ?').run(name, gid)
      if (qq !== undefined) db.prepare('UPDATE groups SET qq_number = ? WHERE group_id = ?').run(qq, gid)
      return true
    },
    members(groupId) {
      const filter = groupId ? 'WHERE group_id = ?' : ''
      const stmt = db.prepare(`
        SELECT sender_id, MAX(sender_name) AS sender_name, COUNT(*) AS n,
               MAX(sent_at) AS latest, SUM(LENGTH(text)) AS chars,
               SUM(CASE WHEN ${activeEmbedding} THEN LENGTH(embedding) ELSE 0 END) AS vec_bytes
        FROM messages ${filter} GROUP BY sender_id ORDER BY latest DESC
      `)
      const rows = stmt.all(currentSpace, currentSpace, ...(groupId ? [String(groupId)] : []))
      return rows.map(r => ({
        senderId: r.sender_id,
        senderName: r.sender_name || '',
        count: Number(r.n) || 0,
        latestAt: Number(r.latest) || 0,
        chars: Number(r.chars) || 0,
        vecBytes: Number(r.vec_bytes) || 0,
      }))
    },
    /**
     * 关键词字面搜索（同步、毫秒级，不需要向量）。
     * 要求至少命中 minHits 个不同关键词，避免单个 2 字片段就把一堆无关消息捞上来；
     * 命中越多排越前。
     */
    searchByKeywords(senderId, keywords, limit = 6, minHits = 2, groupId) {
      const kw = (Array.isArray(keywords) ? keywords : [])
        .map(x => String(x || '').trim())
        .filter(x => x.length >= 2)
        .slice(0, 10)
      if (!kw.length) return []
      const hitExpr = kw.map(() => 'CASE WHEN text LIKE ? THEN 1 ELSE 0 END').join(' + ')
      const params = kw.map(k => `%${k}%`)
      const scope = groupId == null ? [] : [String(groupId)]
      const rows = db.prepare(`
        SELECT id, text, sent_at, group_id, (${hitExpr}) AS hits FROM messages
        WHERE sender_id = ?${scope.length ? ' AND group_id = ?' : ''} AND (${hitExpr}) >= ? AND ${eligible}
        ORDER BY hits DESC, sent_at DESC, id DESC LIMIT ?
      `).all(...params, String(senderId), ...scope, ...params, Math.max(1, Math.min(12, minHits)), Math.max(1, Number(limit) || 6))
      const seen = new Set()
      return rows.filter(r => {
        const t = String(r.text || '').trim()
        if (!t || seen.has(t)) return false
        seen.add(t)
        return true
      }).map(r => ({ id: r.id, text: r.text, sentAt: Number(r.sent_at) || 0, groupId: r.group_id, score: Number(r.hits) || 0 }))
    },
    /** 某个人的消息列表（最新在前，可按群过滤） */
    messagesOf(senderId, groupId, limit = 50, offset = 0, { recall = false } = {}) {
      const lim = Math.max(1, Number(limit) || 50)
      const off = Math.max(0, Number(offset) || 0)
      const scope = groupId ? [String(groupId)] : []
      const rows = db.prepare(`SELECT id, text, sent_at, group_id FROM messages WHERE sender_id = ?
        ${scope.length ? ' AND group_id = ?' : ''}${recall ? ` AND ${eligible}` : ''}
        ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?`).all(String(senderId), ...scope, lim, off)
      return rows.map(r => ({ id: r.id, text: r.text, sentAt: Number(r.sent_at) || 0, groupId: r.group_id }))
    },
    /** 修改一条记忆；手工修改会让原向量失效，并覆盖后续 IM 同步。 */
    updateMessage(messageId, groupId, senderId, text) {
      const id = String(messageId || '')
      const gid = String(groupId || '')
      const sid = String(senderId || '')
      const nextText = String(text ?? '').trim()
      if (!id || !gid || !sid || !nextText) return false
      const row = db.prepare('SELECT id FROM messages WHERE id = ? AND group_id = ? AND sender_id = ?').get(id, gid, sid)
      if (!row) return false
      db.exec('BEGIN')
      try {
        db.prepare('UPDATE messages SET text = ?, embedding = NULL, embedded_at = NULL, embedding_space = NULL WHERE id = ? AND group_id = ? AND sender_id = ?')
          .run(nextText, id, gid, sid)
        stSetOverride.run(id, 'edit', nextText, Date.now())
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return true
    },
    /** 删除一条记忆，并写 tombstone，避免下一轮 IM 增量同步把它复活。 */
    deleteMessage(messageId, groupId, senderId) {
      const id = String(messageId || '')
      const gid = String(groupId || '')
      const sid = String(senderId || '')
      if (!id || !gid || !sid) return false
      const row = db.prepare('SELECT id FROM messages WHERE id = ? AND group_id = ? AND sender_id = ?').get(id, gid, sid)
      if (!row) return false
      db.exec('BEGIN')
      try {
        stSetOverride.run(id, 'delete', null, Date.now())
        db.prepare('DELETE FROM messages WHERE id = ? AND group_id = ? AND sender_id = ?').run(id, gid, sid)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return true
    },
    /** 清除指定群的成员历史，包括尚未导入、但已到达源库的行。 */
    deleteSender(senderId, groupId, through) {
      const sid = String(senderId || '')
      const gid = String(groupId || '')
      if (!sid || !gid) return 0
      const seq = through === undefined ? null : normalizeArrival(through)
      return transaction(() => {
        const prior = seq && stWatermark.get(gid, sid)
        const effective = prior && compareArrival(prior, through) > 0 ? prior : seq
        if (effective?.rowid > 0) stSetWatermark.run(gid, sid, effective.receivedAt, effective.rowid)
        // 多进程情况下，源取快照到本地事务之间可能有新导入行，只清掉水位及以前。
        const filter = 'sender_id = ? AND group_id = ?' + (effective
          ? ' AND (source_received_at IS NULL OR (source_received_at, source_rowid) <= (?, ?))' : '')
        const params = effective ? [sid, gid, effective.receivedAt, effective.rowid] : [sid, gid]
        db.prepare(`INSERT INTO message_overrides (id, action, text, updated_at)
          SELECT id, 'delete', NULL, ? FROM messages WHERE ${filter}
          ON CONFLICT(id) DO UPDATE SET action = 'delete', text = NULL, updated_at = excluded.updated_at`)
          .run(Date.now(), ...params)
        return Number(db.prepare(`DELETE FROM messages WHERE ${filter}`).run(...params).changes)
      })
    },
    /** 真把删掉的空间还给磁盘 */
    vacuum() {
      try { db.exec('VACUUM') } catch {}
    },
    sizeBytes() {
      try {
        const rows = db.prepare('PRAGMA page_count').get()
        const pageSize = db.prepare('PRAGMA page_size').get()
        return (Number(rows?.page_count) || 0) * (Number(pageSize?.page_size) || 0)
      } catch { return 0 }
    },
    getMeta(key, fallback = null) {
      const row = stMetaGet.get(key)
      return row ? row.value : fallback
    },
    setMeta(key, value) {
      stMetaSet.run(key, String(value))
    },
    getProfile(senderId) {
      return stProfile.get(senderId)
    },
    setProfile(senderId, name, profile) {
      stSetProfile.run(senderId, name || '', profile || '', Date.now())
    },
    close() {
      try { db.close() } catch {}
    },
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  const n = a.length
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i += 1) {
    const x = a[i], y = b[i]
    dot += x * y; na += x * x; nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
