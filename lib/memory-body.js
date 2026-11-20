// Match structured QQ tokens, not ambiguous plain-text @names.
const qqMention = /<@!?[A-Za-z0-9_-]+>/g

export function isMemoryBody(text, channel, hasAttachments) {
  if (typeof text !== 'string' || !text.trim()) return false
  return channel !== 'qq' || Boolean(hasAttachments) || Boolean(text.replace(qqMention, '').trim())
}
