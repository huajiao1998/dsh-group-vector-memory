# dsh-group-vector-memory

给 DSH（DeepSeek Harness）的 QQ/飞书群聊加一份**按发送者隔离**的记忆：群里每个人说话时，自动召回**他自己**最近说过的话和相关历史，注入到这一轮的上下文里。

不是全局记忆，是一个群友一份——不会把甲说的话记到乙头上。

## 它做什么

群消息进来时，在模型被调用之前，往这一轮的消息里追加一段记忆块：

```
【群里这个人：王阿牛（ID 7588BBE5…）】
最近说过的：
- 第24支你打算做什么？
- 好吧
- 哎呀，这些事情不用群里说啊，怎么啥事都往群里说
- …
以前说到过的：
- 从群里发的信息不应该会发群信息吗…
以前相关的：
- 在干嘛啊
- 第24支你打算做什么？
```

三段分别来自：

| 段落 | 来源 | 要不要网络 |
|---|---|---|
| 最近说过的 | SQLite 按 sender 取最近 N 条 | 不要 |
| 以前说到过的 | 关键词字面匹配（3~4 字 n-gram + 多词命中排序） | 不要 |
| 以前相关的 | bge-m3 向量语义召回（预向量化缓存） | 要（但已提前算好） |

## 为什么这么注入 —— 三次踩坑换来的

DSH 里能注入记忆的地方不止一个，前三条路都试过，都不行：

### ❌ `agent.inject(user/message)`

往 inbox 塞消息。源码里 `inject` 是 `send(input, "next-step", false)` —— 塞进 next-step **且不唤醒**。turn 不消费就积压，群消息一密就把队列压垮。实测把主会话卡死过一次。

### ❌ `systemPrompt.context()` 的同步 `text()`

主机装配提示词时 `text(context)` 是**同步调用**的（源码里直接执行，不 `await`），塞不进 300ms 的网络向量化。而 fish-memory 那类插件能在里面做召回，是因为它们**全本地关键词匹配**，一次网络都不发。

### ❌ 从 `session.log` 找「最后一条消息」

`systemPrompt` 的 `text()` 在**请求装配时**求值，而这一轮的 user 消息要等装配完才落进 `session.log` —— 拿到的永远是**上一轮**。

### ✅ `agent/pre-step`（waterfall）

DSH 用 `await dispatch.waterfall("agent/pre-step", { messages, turn, step }, …)` 调用它，参数里带着这一轮 claim 到的消息，而且允许返回修改后的 `messages`。

```
agent/pre-step（await，模型还没被调用）
  → 拿到这一轮的 messages
  → await 向量化 + 召回
  → 把记忆块追加进 messages
  → 返回给 DSH → 模型调用
```

不碰 inbox、不塞会话事件、不同步求值——既不卡队列、不慢一拍、也不串号。

## 预向量化

向量期望在 `pre-step` 里就绪，所以有个后台扫描：

```
每 200ms 扫一遍 dsh-im 的 group-history.sqlite
  → 发现新消息 → 立即算向量 → 存内存缓存
  → pre-step 时直接命中（实测 0ms）
```

命中不了就现算（约 300ms），`pre-step` 是 `await` 的，等得起。

**语义查询只用这一条消息的向量**：算不出来就只给最近 N 条和字面召回，绝不拿上一条旧消息的向量冒充——那是错的召回。

## 按群隔离

数据按 `group_id` + `sender_id` 双重隔离。设置页的记忆管理是两级的：先选群，再选人。删除只删「这个群里的这个人」，后端强制要求 `groupId` + `confirm: true`，少一个就拒绝——防止跨群误删。

## 安装

```bash
dsh plugin --profile web add dsh-group-vector-memory
```

装完重启 DSH。插件声明了 `dsh.bundle.patch`，`dsh.profile.bundles` 会自动追加。

## 配置

设置页 → 群聊记忆。也可以直接改 `~/.dsh/plugins/dsh-group-vector-memory/config.json`：

```json
{
  "enabled": true,
  "embedding": {
    "baseUrl": "https://api.siliconflow.cn/v1/embeddings",
    "model": "BAAI/bge-m3",
    "dimensions": 1024,
    "apiKey": "sk-…"
  },
  "recall": {
    "recent": 6,
    "semantic": 8,
    "minScore": 0.25
  },
  "inject": {
    "enabled": true,
    "maxChars": 2000
  }
}
```

`apiKey` 只在服务端用，RPC 返回给前端时会被剥掉，只给 `apiKeySet` / `apiKeyMasked`。

## 数据

`~/.dsh/plugins/dsh-group-vector-memory/memory.sqlite`：

```
messages(id, group_id, sender_id, sender_name, text, sent_at, embedding BLOB)
meta(key, value)      -- last_sent_at 等
profiles(...)         -- 预留
```

向量以 Float32Array 存 BLOB，1024 维 = 4KB/条。设置页能看到每个群、每个人的占用，删人之后自动 `VACUUM` 把空间还给磁盘。

## 开发

```bash
node --test test/all.test.mjs     # 50 个单测
node test/real-data.mjs           # 拿真实 IM 历史跑一遍召回
```

## 许可证

MIT
