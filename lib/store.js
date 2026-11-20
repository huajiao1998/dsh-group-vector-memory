import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
      embedded_at INTEGER
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

  const stUpsert = db.prepare(`
    INSERT INTO messages (id, group_id, sender_id, sender_name, text, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sender_name = excluded.sender_name,
      text = excluded.text,
      embedding = CASE WHEN messages.text = excluded.text THEN messages.embedding ELSE NULL END,
      embedded_at = CASE WHEN messages.text = excluded.text THEN messages.embedded_at ELSE NULL END
  `)
  // 老库升级：早期版本的 groups 表没有 auto_name，补上（建表语句的 IF NOT EXISTS 不会改旧表）
  try {
    const cols = db.prepare('PRAGMA table_info(groups)').all().map(c => c.name)
    if (cols.length && !cols.includes('auto_name')) db.exec("ALTER TABLE groups ADD COLUMN auto_name TEXT NOT NULL DEFAULT ''")
  } catch {}
  const stSetEmbedding = db.prepare('UPDATE messages SET embedding = ?, embedded_at = ? WHERE id = ? AND text = ? AND embedding IS NULL')
  const stOverride = db.prepare('SELECT action, text FROM message_overrides WHERE id = ?')
  const stSetOverride = db.prepare(`
    INSERT INTO message_overrides (id, action, text, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET action = excluded.action, text = excluded.text, updated_at = excluded.updated_at
  `)
  const stMissing = db.prepare('SELECT id, text FROM messages WHERE embedding IS NULL ORDER BY sent_at ASC LIMIT ?')
  const stRecent = db.prepare('SELECT text, sent_at FROM messages WHERE sender_id = ? ORDER BY sent_at DESC LIMIT ?')
  const stAllVecs = db.prepare('SELECT id, sender_id, text, sent_at, embedding FROM messages WHERE embedding IS NOT NULL AND sender_id = ? ORDER BY sent_at DESC LIMIT ?')
  const stCount = db.prepare('SELECT COUNT(*) AS n FROM messages')
  const stCountEmbedded = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE embedding IS NOT NULL')
  const stBySender = db.prepare('SELECT sender_id, sender_name, COUNT(*) AS n FROM messages GROUP BY sender_id ORDER BY n DESC LIMIT ?')
  const stMetaGet = db.prepare('SELECT value FROM meta WHERE key = ?')
  const stMetaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const stProfile = db.prepare('SELECT * FROM profiles WHERE sender_id = ?')
  const stSetProfile = db.prepare(`
    INSERT INTO profiles (sender_id, sender_name, profile, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(sender_id) DO UPDATE SET sender_name = excluded.sender_name, profile = excluded.profile, updated_at = excluded.updated_at
  `)

  return {
    path,
    upsertMessages(rows) {
      let added = 0
      db.exec('BEGIN')
      try {
        for (const r of rows) {
          const override = stOverride.get(String(r.id))
          if (override?.action === 'delete') continue
          const text = override?.action === 'edit' && typeof override.text === 'string' ? override.text : r.text
          const res = stUpsert.run(r.id, r.groupId, r.senderId, r.senderName || '', text, r.sentAt)
          if (res.changes > 0) added += 1
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return added
    },
    pendingEmbeddings(limit = 50) {
      return stMissing.all(limit)
    },
    /** 只给生成向量时看到的原文写回，避免编辑竞态把旧向量错配到新文本。 */
    setEmbedding(id, vec, expectedText = null) {
      const text = expectedText == null ? null : String(expectedText)
      const result = text == null
        ? db.prepare('UPDATE messages SET embedding = ?, embedded_at = ? WHERE id = ? AND embedding IS NULL').run(vecToBlob(vec), Date.now(), id)
        : stSetEmbedding.run(vecToBlob(vec), Date.now(), id, text)
      return Number(result?.changes) || 0
    },
    recentBySender(senderId, limit) {
      return stRecent.all(senderId, limit)
    },
    vectorsBySender(senderId, limit = 2000) {
      return stAllVecs.all(senderId, limit).map(r => ({ ...r, vector: blobToVec(r.embedding) }))
    },
    stats() {
      return {
        messages: stCount.get().n,
        embedded: stCountEmbedded.get().n,
        senders: stBySender.all(50),
      }
    },
    /** 按群统计：哪个群、多少条、几个人、最新时间、占用 */
    groups() {
      return db.prepare(`
        SELECT group_id, COUNT(*) AS n, COUNT(DISTINCT sender_id) AS people,
               MAX(sent_at) AS latest, SUM(LENGTH(text)) AS chars,
               SUM(CASE WHEN embedding IS NOT NULL THEN LENGTH(embedding) ELSE 0 END) AS vec_bytes
        FROM messages GROUP BY group_id ORDER BY latest DESC
      `).all().map(r => ({
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
        INSERT INTO groups (group_id, channel, platform_group_id, synced_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          channel = excluded.channel,
          platform_group_id = excluded.platform_group_id,
          synced_at = excluded.synced_at
      `)
      let n = 0
      for (const r of list) {
        const gid = String(r?.id || r?.groupId || '')
        if (!gid) continue
        try {
          stmt.run(gid, String(r?.channel || ''), String(r?.platform_group_id || r?.platformGroupId || ''), now)
          n += 1
        } catch {}
      }
      return n
    },
    /** 全部群信息（含人工填的名字和群号） */
    groupInfo() {
      return db.prepare(`SELECT group_id, channel, platform_group_id, qq_number, name, auto_name FROM groups ORDER BY group_id`).all()
        .map(r => ({
          groupId: r.group_id,
          channel: r.channel,
          platformGroupId: r.platform_group_id,
          qqNumber: r.qq_number,
          name: r.name,
          autoName: r.auto_name,
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
               SUM(CASE WHEN embedding IS NOT NULL THEN LENGTH(embedding) ELSE 0 END) AS vec_bytes
        FROM messages ${filter} GROUP BY sender_id ORDER BY latest DESC
      `)
      const rows = groupId ? stmt.all(String(groupId)) : stmt.all()
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
    searchByKeywords(senderId, keywords, limit = 6, minHits = 2) {
      const kw = (Array.isArray(keywords) ? keywords : [])
        .map(x => String(x || '').trim())
        .filter(x => x.length >= 2)
        .slice(0, 10)
      if (!kw.length) return []
      const hitExpr = kw.map(() => 'CASE WHEN text LIKE ? THEN 1 ELSE 0 END').join(' + ')
      const params = kw.map(k => `%${k}%`)
      const rows = db.prepare(`
        SELECT text, sent_at, group_id, (${hitExpr}) AS hits FROM messages
        WHERE sender_id = ? AND (${hitExpr}) >= ?
        ORDER BY hits DESC, sent_at DESC LIMIT ?
      `).all(...params, String(senderId), ...params, Math.max(1, Math.min(12, minHits)), Math.max(1, Number(limit) || 6))
      const seen = new Set()
      return rows.filter(r => {
        const t = String(r.text || '').trim()
        if (!t || seen.has(t)) return false
        seen.add(t)
        return true
      }).map(r => ({ text: r.text, sentAt: Number(r.sent_at) || 0, groupId: r.group_id, score: Number(r.hits) || 0 }))
    },
    /** 某个人的消息列表（最新在前，可按群过滤） */
    messagesOf(senderId, groupId, limit = 50, offset = 0) {
      const lim = Math.max(1, Number(limit) || 50)
      const off = Math.max(0, Number(offset) || 0)
      const rows = groupId
        ? db.prepare(`SELECT id, text, sent_at, group_id FROM messages WHERE sender_id = ? AND group_id = ? ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?`).all(String(senderId), String(groupId), lim, off)
        : db.prepare(`SELECT id, text, sent_at, group_id FROM messages WHERE sender_id = ? ORDER BY sent_at DESC, id DESC LIMIT ? OFFSET ?`).all(String(senderId), lim, off)
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
        db.prepare('UPDATE messages SET text = ?, embedding = NULL, embedded_at = NULL WHERE id = ? AND group_id = ? AND sender_id = ?')
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
    /** 硬删某个人的消息（指定群就只删那个群），返回删除条数 */
    deleteSender(senderId, groupId) {
      const sid = String(senderId || '')
      const gid = String(groupId || '')
      if (!sid || !gid) return 0
      const rows = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND group_id = ?').all(sid, gid)
      if (!rows.length) return 0
      db.exec('BEGIN')
      try {
        for (const row of rows) stSetOverride.run(row.id, 'delete', null, Date.now())
        db.prepare('DELETE FROM messages WHERE sender_id = ? AND group_id = ?').run(sid, gid)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return rows.length
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
