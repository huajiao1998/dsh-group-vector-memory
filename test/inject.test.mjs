import assert from 'node:assert/strict'
import { parseImSource } from '../lib/inject.js'

const mk = (meta, text = '你好') => ({
  type: 'user/message',
  data: { content: [ { type: 'text', text: `<dsh_im_source>${JSON.stringify(meta)}</dsh_im_source>\n${text}` } ] },
})

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name) }
  catch (e) { fail++; console.log('  ✗', name, '→', e.message) }
}

console.log('parseImSource:')

t('群消息（dsh-im 实际字段，无 conversationType）', () => {
  const m = parseImSource(mk({ channel: 'qq', senderId: '7588BBE531F706E8BDB7C925FF050E55', senderName: '王阿牛', chatId: '551FE0B7DDCD9A6177C0ABEC525CFBF9' }))
  assert.equal(m.senderId, '7588BBE531F706E8BDB7C925FF050E55')
  assert.equal(m.chatId, '551FE0B7DDCD9A6177C0ABEC525CFBF9')
  assert.equal(m.conversationType, undefined)
})

t('带 conversationType 的群消息', () => {
  const m = parseImSource(mk({ channel: 'qq', conversationType: 'group', senderId: 'u1', chatId: 'g1' }))
  assert.equal(m.conversationType, 'group')
})

t('私聊（无 chatId）', () => {
  const m = parseImSource(mk({ channel: 'qq', conversationType: 'c2c', senderId: 'u1' }))
  assert.equal(m.chatId, undefined)
})

t('没有 source 的普通消息 → null', () => {
  assert.equal(parseImSource({ type: 'user/message', data: { content: [{ type: 'text', text: '普通消息' }] } }), null)
})

t('JSON 里被转义的尖括号也能解析', () => {
  const raw = '{"channel":"qq","senderId":"u1","senderName":"\\u003cb\\u003e"}'
  const m = parseImSource({ type: 'user/message', data: { content: [{ type: 'text', text: `<dsh_im_source>${raw}</dsh_im_source>\nhi` }] } })
  assert.equal(m.senderName, '<b>')
})

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
