import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createStore } from '../lib/store.js'
import { recallSync } from '../lib/recall.js'

const row = (id, text, extra = {}) => ({ id, groupId: 'g', senderId: 's', text, sentAt: 1, ...extra })
const vector = Float32Array.of(1, 0)

test('ingest and prewarm share the message filter without altering accepted text', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-body-'))
  const store = createStore(dir.path)
  try {
    store.upsertGroups([{ id: 'g', channel: 'qq' }])
    const rejected = [row('blank', '\n\t\u3000'), row('mention', ' <@ABC>\n<@!DEF_2>  '),
      row('by-channel', '<@ABC>', { groupId: 'unseen', channel: 'qq' })]
    const accepted = [row('with-text', ' <@ABC> hello '), row('punctuation', '<@ABC>!'), row('visible', '@名字'),
      row('other', '<@ABC>', { groupId: 'non-qq', channel: 'feishu' }),
      row('unknown', '<@ABC>', { groupId: 'unknown' }), row('media', '<@ABC>', { hasAttachments: true })]
    const input = [...accepted, ...rejected].map((message, i) => ({ ...message, sourceSeq: { receivedAt: 100, rowid: i + 1 } }))
    assert.deepEqual(input.map(message => store.textForPrewarm(message)), [...accepted.map(r => r.text), '', '', ''])
    const through = input.at(-1).sourceSeq
    assert.equal(store.upsertMessages(input, through), accepted.length)
    assert.deepEqual(store.getSyncCursor(), through)
    assert.equal(store.upsertMessages(input, through), 0)
    assert.deepEqual(store.embeddingCounts(), { total: accepted.length, embedded: 0 })
    assert.equal(store.messagesOf('s', 'g').find(r => r.id === 'with-text').text, ' <@ABC> hello ')
    assert.equal(store.recentBySender('s', 1, 'non-qq').at(0).id, 'other')
    assert.equal(store.recentBySender('s', 1, 'unknown').at(0).id, 'unknown')
  } finally { store.close() }
})

test('legacy blank and QQ mention rows stay stored but are ineligible before recall limits and rebuild counts', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gvm-body-legacy-'))
  const path = join(dir.path, 'memory.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, sent_at INTEGER NOT NULL,
      embedding BLOB, embedded_at INTEGER, embedding_space TEXT
    )`)
    const insert = db.prepare(`INSERT INTO messages(id, group_id, sender_id, text, sent_at, embedding, embedding_space)
      VALUES (?, 'g', 's', ?, ?, ?, 'test-space')`)
    const blob = Buffer.from(vector.buffer)
    insert.run('latest-blank', '\t\u3000', 7, blob)
    insert.run('latest-mention', '<@ABC>', 6, blob)
    insert.run('pending-blank', ' ', 0, null)
    insert.run('pending-mention', '<@ABC><@DEF>', 2, null)
    insert.run('pending-text', '<@ABC> hello', 3, null)
    insert.run('second-text', 'readable text', 4, null)
    insert.run('embedded-text', 'ABC memory', 5, blob)
  } finally { db.close() }
  const store = createStore(dir.path)
  try {
    store.upsertGroups([{ id: 'g', channel: 'qq' }])
    store.useEmbeddingSpace('test-space')
    assert.deepEqual(store.embeddingCounts(), { total: 3, embedded: 1 })
    assert.deepEqual(store.pendingEmbeddings(1).map(r => r.id), ['pending-text'])
    assert.deepEqual(store.pendingEmbeddings(1, { sentAt: 3, id: 'pending-text' }).map(r => r.id), ['second-text'])
    assert.equal(store.needsEmbedding('pending-mention', '<@ABC><@DEF>'), false)
    assert.equal(store.setEmbedding('pending-mention', vector), 0)
    assert.equal(store.setEmbedding('pending-text', vector, '<@ABC> hello'), 1)
    assert.deepEqual(store.embeddingCounts(), { total: 3, embedded: 2 })
    assert.deepEqual(store.recentBySender('s', 1, 'g').map(r => r.id), ['embedded-text'])
    assert.deepEqual(store.searchByKeywords('s', ['ABC'], 1, 1, 'g').map(r => r.id), ['embedded-text'])
    assert.deepEqual(store.vectorsBySender('s', 1, 'g').map(r => r.id), ['embedded-text'])
    const recall = recallSync({ store, senderId: 's', groupId: 'g', query: 'ABC', queryVec: vector,
      cfg: { recall: { recent: 1, semantic: 1 } } })
    assert.deepEqual(recall.recent.map(r => r.id), ['embedded-text'])
    assert.deepEqual(recall.semantic.map(r => r.id), ['pending-text'])
    assert.equal(store.messagesOf('s', 'g').length, 7)
    const kept = new DatabaseSync(path, { readOnly: true })
    try {
      assert.deepEqual(kept.prepare("SELECT hex(embedding) AS value FROM messages WHERE id = 'latest-mention'").get().value,
        Buffer.from(vector.buffer).toString('hex').toUpperCase())
    } finally { kept.close() }
  } finally { store.close() }
})
