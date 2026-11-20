/**
 * 从 QQ 机器人接口拉群名。
 *
 * 一开始我以为官方接口不返回群名，是错的：`GET /v2/groups/{group_openid}/info`
 * 直接给 group_name / group_member_num。凭据从 dsh-qqchat 的库里读，不写死。
 *
 * 拉到的名字存进 groups.auto_name；人工填的 name 优先级更高。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

export function defaultQqChatPath() {
  return join(homedir(), '.dsh', 'plugins', 'dsh-qqchat', 'qqchat.sqlite')
}

/** 读 dsh-qqchat 里启用的机器人账号凭据（只读） */
function readAccount(dbPath) {
  if (!existsSync(dbPath)) return null
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT app_id, app_secret, sandbox FROM accounts WHERE enabled = 1 ORDER BY id LIMIT 1').get()
    if (!row) return null
    return { appId: String(row.app_id), secret: String(row.app_secret), sandbox: Boolean(row.sandbox) }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

export function createQqInfoReader(dbPath = defaultQqChatPath()) {
  const account = () => readAccount(dbPath)

  return {
    path: dbPath,
    available() {
      const a = account()
      return Boolean(a?.appId && a?.secret)
    },
    /** 拉一批群的群名：openid -> { name, memberNum } */
    async groupNames(openids) {
      const acct = account()
      const list = [...new Set((openids || []).map(String).filter(Boolean))]
      if (!acct || !list.length) return new Map()

      const base = acct.sandbox ? 'https://api.sandbox.qq.com' : 'https://api.sgroup.qq.com'
      let token = ''
      try {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: acct.appId, clientSecret: acct.secret }),
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return new Map()
        token = (await res.json())?.access_token || ''
      } catch {
        return new Map()
      }
      if (!token) return new Map()

      const out = new Map()
      for (const openid of list) {
        try {
          const res = await fetch(`${base}/v2/groups/${openid}/info`, {
            headers: { Authorization: `QQBot ${token}` },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) continue
          const d = await res.json()
          const name = String(d?.group_name || '').trim()
          if (name) out.set(openid, { name, memberNum: Number(d?.group_member_num) || 0 })
        } catch {}
      }
      return out
    },
  }
}
