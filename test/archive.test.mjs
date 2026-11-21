import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createImReader } from '../lib/dshim.js'
import { createStore } from '../lib/store.js'
import { createRpc } from '../lib/rpc.js'

const time = Date.parse('2026-11-20T08:30:00+08:00')

test('原文逐页增量复制，出站、纯 @ 和空白不会进入向量记忆', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-archive-'))
  const sourcePath = join(dir.path, 'source.sqlite')
  const source = new DatabaseSync(sourcePath)
  const reader = createImReader(sourcePath)
  const store = createStore(dir.path)
  try {
    source.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, channel TEXT);
      INSERT INTO groups VALUES ('g1', 'qq'), ('g2', 'qq');
      CREATE TABLE messages (id TEXT PRIMARY KEY, group_id TEXT, platform_message_id TEXT, sender_id TEXT,
        sender_name TEXT, text TEXT, sent_at INTEGER, received_at INTEGER, type TEXT);
      CREATE TABLE attachments (message_id TEXT);
      INSERT INTO attachments VALUES ('empty');`)
    const insert = source.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('a', 'g1', 'message-a', 'member', '群友甲', '换模型 123%', time, 1, 'text')
    insert.run('b', 'g1', 'message-b', 'qq-bot', '小鱼', '换模型\n确认', time + 1, 2, 'outbound-text')
    insert.run('at', 'g1', 'message-at', 'member', '群友甲', '<@bot>', time + 1, 3, 'text')
    insert.run('empty', 'g1', 'message-empty', 'member', '群友甲', '', time + 1, 4, 'file')
    insert.run('blank', 'g1', 'message-blank', 'member', '群友甲', '  ', time + 1, 5, 'text')
    insert.run('other', 'g2', 'message-other', 'member', '群友甲', '换模型 未授权群', time + 2, 6, 'text')
    let rows
    do {
      rows = reader.sinceArrival(store.archive.cursor(), 2)
      if (rows.length) assert.equal(store.archive.copy(rows), rows.length)
    } while (rows.length)
    rows = reader.sinceArrival(0, 10)
    assert.equal(store.archive.copy(rows), 0)
    store.upsertMessages(rows, rows.at(-1).sourceSeq)
    assert.deepEqual(store.pendingEmbeddings().map(row => row.id).sort(), ['g1:message-a', 'g2:message-other'])
    assert.deepEqual(store.archive.query('g1', { speaker: 'self' }).items.map(row => row.text), ['换模型\n确认'])
    assert.deepEqual(store.archive.query('g1', { speaker: 'others', person: '群友', keyword: '123%', to: '2026-11-20T00:30:00Z' }).items.map(row => row.id), ['a'])
    assert.deepEqual(store.archive.query('g1', { keyword: '不存在' }).items, [])
    assert.throws(() => store.archive.query('g1', { from: '2026-02-30T00:00:00Z' }), /日期无效/)
    const date = '2026-11-20'
    const midnight = new Date(`${date}T00:00:00`).getTime()
    const nextMidnight = new Date('2026-11-21T00:00:00').getTime()
    store.archive.copy([['before', midnight - 1], ['start', midnight], ['end', nextMidnight - 1], ['after', nextMidnight]].map(([id, sentAt], i) => ({
      groupId: 'days', sourceId: id, sourceSeq: { receivedAt: 1, rowid: i + 1 }, senderId: 'member', senderName: '群友',
      direction: 'inbound', hasAttachments: false, text: id, sentAt,
    })))
    const dayRows = store.archive.query('days', { from: date, to: date }).items
    assert.deepEqual(dayRows.map(item => [item.id, item.date]), [['end', date], ['start', date]])
    assert.throws(() => store.archive.query('days', { from: '2026-11-21', to: date }), /开始日期/)
    const page = store.archive.query('g1', { limit: 2 })
    assert.deepEqual(page.items.map(row => row.id), ['empty', 'blank'])
    assert.equal(page.items[0].hasAttachments, true)
    assert.throws(() => store.archive.query('g2', { cursor: page.nextCursor }), /分页游标/)
    const second = store.archive.query('g1', { cursor: page.nextCursor })
    assert.deepEqual(second.items.map(row => row.id), ['b', 'at', 'a'])
    const rpc = createRpc({ store })
    assert.deepEqual(await rpc('archive/query', { groupId: 'g1', limit: 2 }), { ok: true, value: page })
    assert.deepEqual(await rpc('archive/query', { keyword: '模型' }), {
      ok: false, error: { code: 'internal', message: '请选择一个群。', details: {} },
    })

    insert.run('long', 'g1', 'message-long', 'member', '群友甲', `${'前'.repeat(4300)}关键词END`, time + 2, 7, 'text')
    assert.equal(store.archive.copy(reader.sinceArrival(store.archive.cursor())), 1)
    const [long] = store.archive.query('g1', { keyword: '关键词end' }).items
    assert.ok(long.textTruncated)
    assert.match(long.text, /关键词END/)
  } finally {
    store.close()
    reader.close()
    source.close()
  }
})
