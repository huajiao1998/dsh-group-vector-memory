import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createImReader } from '../lib/dshim.js'
import { createStore } from '../lib/store.js'

function fixture(dir) {
  const imPath = join(dir, 'im.sqlite')
  const db = new DatabaseSync(imPath)
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, platform_message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
    sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL
  )`)
  const insert = db.prepare(`INSERT INTO messages
    (id, group_id, platform_message_id, sender_id, text, sent_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const im = createImReader(imPath)
  return {
    db, im,
    insert(id, { group = 'g1', platform = id, sender = 'u1', text = id, sentAt = 10, receivedAt = 100 } = {}) {
      insert.run(id, group, platform, sender, text, sentAt, receivedAt)
    },
    [Symbol.dispose]() { im.close(); db.close() },
  }
}

function runBatch(store, im, limit, filter = () => true) {
  const rows = im.sinceArrival(store.getSyncCursor(), limit)
  if (rows.length) store.upsertMessages(rows.filter(filter), rows.at(-1).sourceSeq)
  return rows.map(row => row.sourceId)
}

test('arrival: identical receive times page in arrival order, and late sent times are not lost', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('z', { sentAt: 1000 })
  source.insert('y', { sentAt: 2000 })
  source.insert('a', { sentAt: 1000 })
  const initial = createStore(dir.path)
  try {
    assert.deepEqual(runBatch(initial, source.im, 2), ['z', 'y'])
  } finally { initial.close() }
  const store = createStore(dir.path)
  try {
    assert.deepEqual(runBatch(store, source.im, 2), ['a'])
    assert.deepEqual(runBatch(store, source.im, 2), [])
    source.insert('b', { sentAt: 1, receivedAt: 101 })
    assert.deepEqual(runBatch(store, source.im, 2), ['b'])
    assert.equal(store.stats().messages, 4)
    assert.deepEqual(store.getSyncCursor(), source.im.latestArrival())
    // The installed IM retention routine can empty the table and let SQLite reuse rowid 1.
    source.db.exec('DELETE FROM messages')
    source.insert('c', { sentAt: 1, receivedAt: 102 })
    assert.equal(source.im.latestArrival().rowid, 1)
    assert.deepEqual(runBatch(store, source.im, 2), ['c'])
  } finally { store.close() }
})

test('arrival: rows and progress roll back together; empty filtered pages still advance', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('a')
  source.insert('b')
  const store = createStore(dir.path)
  try {
    const rows = source.im.sinceArrival()
    assert.throws(() => store.upsertMessages([rows[0], { ...rows[1], text: null }], rows[1].sourceSeq), /NOT NULL/)
    assert.equal(store.stats().messages, 0)
    assert.equal(store.getSyncCursor(), 0)
    assert.deepEqual(runBatch(store, source.im, 1, () => false), ['a'])
    assert.equal(store.stats().messages, 0)
    assert.deepEqual(runBatch(store, source.im, 1), ['b'])
    const cursor = store.getSyncCursor()
    assert.equal(store.upsertMessages([], rows[0].sourceSeq), 0)
    assert.deepEqual(store.getSyncCursor(), cursor)
  } finally { store.close() }
})

test('clear: removes unsynced history in precisely one member/group and keeps arrivals after the snapshot', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('persisted')
  const initial = createStore(dir.path)
  try {
    runBatch(initial, source.im, 10)
    source.insert('unsynced')
    source.insert('other-sender', { sender: 'u2' })
    source.insert('other-group', { group: 'g2' })
    source.insert('unsynced-empty-member', { sender: 'u3' })
    const through = source.im.latestArrival()
    assert.equal(initial.deleteSender('u3', 'g1', through), 0)
    // Simulate ingest winning the race with clear after the source snapshot was taken.
    source.insert('after-snapshot', { sentAt: 1 })
    runBatch(initial, source.im, 10)
    assert.equal(initial.deleteSender('u1', 'g1', through), 2)
  } finally { initial.close() }
  const store = createStore(dir.path)
  try {
    const replay = source.im.sinceArrival()
    assert.equal(store.upsertMessages(replay, replay.at(-1).sourceSeq), 0)
    assert.deepEqual(store.messagesOf('u1', 'g1').map(row => row.text), ['after-snapshot'])
    assert.deepEqual(store.messagesOf('u2', 'g1').map(row => row.text), ['other-sender'])
    assert.deepEqual(store.messagesOf('u1', 'g2').map(row => row.text), ['other-group'])
    assert.deepEqual(store.messagesOf('u3', 'g1'), [])
    source.insert('after-restart', { sender: 'u3', sentAt: 1 })
    runBatch(store, source.im, 1)
    assert.deepEqual(store.messagesOf('u3', 'g1').map(row => row.text), ['after-restart'])
  } finally { store.close() }
})

test('clear: a pruned source cannot leave newer local history behind', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('old')
  source.insert('other', { group: 'g2' })
  const store = createStore(dir.path)
  try {
    runBatch(store, source.im, 10)
    source.db.exec('DELETE FROM messages')
    assert.equal(source.im.latestArrival(), 0)
    assert.equal(store.deleteSender('u1', 'g1', source.im.latestArrival(store.getSyncCursor())), 1)
    assert.equal(store.stats().messages, 1)
    source.insert('new', { receivedAt: 101 })
    assert.deepEqual(runBatch(store, source.im, 10), ['new'])
    assert.deepEqual(store.messagesOf('u1', 'g1').map(row => row.id), ['g1:new'])
  } finally { store.close() }
})

test('clear: a legacy fallback tombstone does not suppress a new source row after the watermark', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('old-source', { platform: '', text: 'same text' })
  const store = createStore(dir.path)
  try {
    store.upsertMessages([{ id: 'g1:fallback:10:u1:2', groupId: 'g1', senderId: 'u1', text: 'same text', sentAt: 10 }])
    assert.equal(store.deleteSender('u1', 'g1', source.im.latestArrival()), 1)
    source.insert('new-source', { platform: '', text: 'same text' })
    runBatch(store, source.im, 10)
    assert.deepEqual(store.messagesOf('u1', 'g1').map(row => row.id), ['g1:source:new-source'])
  } finally { store.close() }
})

test('migration: replay ignores sent_at cursor and preserves old fallback IDs, edits, tombstones and vectors', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('dup-z', { platform: '', text: 'repeated', sentAt: 10 })
  source.insert('dup-a', { platform: '', text: 'repeated', sentAt: 10 })
  source.insert('edited', { platform: '', text: 'original', sentAt: 20 })
  source.insert('deleted', { platform: '', text: 'removed', sentAt: 30 })
  source.insert('late', { sentAt: 5 })
  const legacy = new DatabaseSync(join(dir.path, 'memory.sqlite'))
  legacy.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, sent_at INTEGER NOT NULL,
      embedding BLOB, embedded_at INTEGER);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE message_overrides (id TEXT PRIMARY KEY, action TEXT NOT NULL, text TEXT, updated_at INTEGER NOT NULL);
    INSERT INTO meta VALUES ('last_sent_at', '1000'), ('last_message_cursor', '{"sentAt":1000,"sourceId":"zzz"}');
    INSERT INTO messages VALUES
      ('g1:fallback:10:u1:8', 'g1', 'u1', '', 'repeated', 10, X'0000803F', 100),
      ('g1:fallback:10:u1:10', 'g1', 'u1', '', 'repeated', 10, NULL, NULL),
      ('g1:fallback:20:u1:2', 'g1', 'u1', '', 'edited text', 20, NULL, NULL);
    INSERT INTO message_overrides VALUES
      ('g1:fallback:20:u1:2', 'edit', 'edited text', 100),
      ('g1:fallback:30:u1:3', 'delete', NULL, 100);
  `)
  legacy.close()
  const initial = createStore(dir.path)
  try {
    assert.equal(initial.getSyncCursor(), 0)
    assert.deepEqual(runBatch(initial, source.im, 1), ['dup-z'])
  } finally { initial.close() }
  const store = createStore(dir.path)
  try {
    assert.deepEqual(runBatch(store, source.im, 4), ['dup-a', 'edited', 'deleted', 'late'])
    const replay = source.im.sinceArrival()
    assert.equal(store.upsertMessages(replay, replay.at(-1).sourceSeq), 0)
    assert.deepEqual(store.messagesOf('u1', 'g1').map(({ id, text }) => [id, text]), [
      ['g1:fallback:20:u1:2', 'edited text'],
      ['g1:fallback:10:u1:8', 'repeated'],
      ['g1:fallback:10:u1:10', 'repeated'],
      ['g1:late', 'late'],
    ])
    assert.deepEqual([...store.vectorsBySender('u1')[0].vector], [1])
    assert.equal(store.deleteMessage('g1:fallback:10:u1:8', 'g1', 'u1'), true)
    assert.equal(store.upsertMessages(replay, replay.at(-1).sourceSeq), 0)
    assert.equal(store.stats().messages, 3)
  } finally { store.close() }
})

test('store: group queries and embedding-space changes do not mix results', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-sync-'))
  using source = fixture(dir.path)
  source.insert('one', { text: 'shared phrase first' })
  source.insert('two', { group: 'g2', text: 'shared phrase second', sentAt: 15 })
  const store = createStore(dir.path)
  try {
    runBatch(store, source.im, 10)
    assert.equal(store.setEmbedding('g1:one', new Float32Array([1]), 'shared phrase first'), 1)
    store.useEmbeddingSpace('model-a')
    assert.equal(store.stats().embedded, 0)
    assert.equal(store.pendingEmbeddings().length, 2)
    assert.equal(store.setEmbedding('g1:one', new Float32Array([1]), 'shared phrase first', 'model-a'), 1)
    assert.equal(store.setEmbedding('g2:two', new Float32Array([1]), 'shared phrase second', 'model-a'), 1)
    assert.deepEqual(store.recentBySender('u1', 1, 'g1').map(r => [r.id, r.sentAt, r.groupId]), [['g1:one', 10, 'g1']])
    assert.deepEqual(store.vectorsBySender('u1', 1, 'g1').map(r => [r.id, r.sentAt, r.groupId]), [['g1:one', 10, 'g1']])
    assert.deepEqual(store.searchByKeywords('u1', ['shared', 'phrase'], 1, 2, 'g1').map(r => [r.id, r.sentAt, r.groupId]), [['g1:one', 10, 'g1']])
    store.useEmbeddingSpace('model-b')
    assert.equal(store.stats().embedded, 0)
    assert.equal(store.groups().find(g => g.groupId === 'g1').vecBytes, 0)
    assert.equal(store.members('g1')[0].vecBytes, 0)
    assert.deepEqual(store.vectorsBySender('u1'), [])
    assert.equal(store.setEmbedding('g1:one', new Float32Array([2]), 'shared phrase first', 'model-a'), 0)
    assert.equal(store.setEmbedding('g1:one', new Float32Array([2]), 'shared phrase first', 'model-b'), 1)
    assert.equal(store.groups().find(g => g.groupId === 'g1').vecBytes, 4)
    assert.equal(store.members('g1')[0].vecBytes, 4)
  } finally { store.close() }
})
