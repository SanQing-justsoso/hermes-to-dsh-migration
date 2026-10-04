# hermes-to-dsh-migration

把一个智能体运行环境（源环境，下称 **Hermes**）的“智能体系 + 用户画像 + 会话记录”迁移到
**DeepSeek Harness（DSH）**的技术笔记与可复用工具。

全程对源环境**严格只读**：只读取、从不写回，重活都在目标的沙箱工作区里做。

> 本文只描述**可复用的技术与踩坑**，不含任何个人数据。所有脚本中的路径都用参数/环境变量注入。

---

## 1. DSH 会话是怎么存盘的

DSH 的会话持久化（`@deepseek-ai/dsh-session-persistence-jsonl`）有几个关键事实，全部逆向了自一份真实会话：

* **一会话一个目录**：`$DSH_HOME/sessions/<sanitized-cwd>/session-<uuid>/`
  * `<sanitized-cwd>` 是工作区绝对路径把 `/` 换成 `-` 再前后各包一个 `-`，例如
    `/a/b/c` → `--a-b-c--`
* **一会话一个追加式日志**：`session.v4.jsonl.zstd`
* **每个 JSONL 行 = 一个独立的、带校验和的 zstd frame**（`ZSTD_c_checksumFlag=1`），帧依次拼接
* **第 0 帧只有一个会话头**（且必须“恰好一行，以换行结尾”）：

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms epoch>,
 "cwd":"<abs path>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

会话列表还登记在 `$DSH_HOME/storages/workspace.json`（`tables.workspaces[*].sessionIds`）。
`$DSH_HOME/storages/session_projcache/sessions/<id>.json` 是**投影缓存**（标题等），由事件日志物化而来，
缓存缺失时只要日志能加载，DSH 打开会话会把标题投影出来。

**⚠️ Node 的 zstd 是单帧的。** `zlib.zstdDecompressSync()` / `createZstdDecompress()` 都只解**第一帧**就停，
不会自动串联多帧。所以必须自己按帧切分 —— 见 `scripts/zstd_frames.py`（按 RFC 8878 解析
frame header + block header，精确求出每个 frame 的字节区间）。

反过来**写**帧时 Node 也能产出 DSH 同款帧，但有个坑：`{checksum:true}` 选项在 Node 22 上被
**静默忽略**，必须走低层参数：
`zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })`
（产出 FHD `00100100` = single_segment + checksum，与 DSH 自己的 writer 逐位同款）。

---

## 2. v4 事件模型

日志 = 会话头帧 + 每事件一帧。每事件统一信封：

```json
{ "type": "<event type>", "seq": <int, 从 0 连续递增>, "time": <ms epoch>, "data": { … } }
```

常用事件（按 `SessionEventMap`）：

| type | data |
|---|---|
| `permission/preset` | `{ preset }` |
| `sandbox/mode` | `{ mode }` |
| `approval/policy` | `{ policy }` |
| `model/selection` | `{ provider, model }` |
| `turn/start` | `{ turn }` |
| `step/start` | `{ turn, step }` |
| `user/message` | 本身即消息体：`{ role:"user", content:[…], source:{kind:"user",…}, id }` |
| `assistant/message` | `{ turn, step, message:{role:"assistant", content:[…], source:{kind:"model",provider,model,replayState}, id}, stream:[] }` |
| `tool/call` | `{ turn, step, callId, name, arguments }` |
| `tool/result` | `{ turn, step, message:{role:"tool", source:{kind:"tool",callId}, toolCallId, content:[…], isError, id } }` |
| `step/end` | `{ turn, step }` |
| `turn/end` | `{ turn, reason:{ kind } }` |
| `session/title` | `{ title, messageSeqs:[<user/message 的 seq>], source:{kind:"fallback"} }` |

`content` 是 part 数组，part 类型如 `text{text}`、`reasoning{text}`、`tool-call{id,name,arguments}`。
`arguments` 是**字符串化的 JSON**。

---

## 3. 真正会让你“会话损坏”的校验规则（踩坑全记录）

DSH 打开会话会用一组严格校验器复盘日志；不合法直接 `is corrupt` 拒绝加载。**逐步踩过来的坑：**

### 3.1 `tool/result` 必须是一等消息
`assertV4ToolResultMessage`：`data.message` 必须
* 有**非空字符串 `id`**（最早漏这个，报 `requires a first-class message with a string id`）
* `role === "tool"`
* `toolCallId === source.callId`（都非空），`source.kind === "tool"`
* `content` 是数组、且不含 `tool-result` 包装块
* `isError` 存在则必须是 boolean

### 3.2 `assistant/message` 的 `stream` 是必填
接口里 `stream: AssistantStreamRecord[]` 不是可选；历史导入给个空数组 `stream: []` 即可。

### 3.3 轮次必须显式收尾
`Relationships` 状态机：`turn/start` 只有在“当前没有开着的 turn”且 `turn === nextTurn` 时才合法；
关一个 turn 必须 `turn/end`。**只发 `turn/start` 不发 `turn/end`，第二个 `turn/start` 就报
`turn/start does not open the expected turn`。**
* `turn/end`：`data.turn === 当前 turn`、**当前没有开着的 step**、`reason` 是对象形如 `{kind:"completed"}`
* `step/start`：`step === nextStep`（turn 内从 1 递增，`nextStep` 在 `step/start` 时即自增）
* `step/end`：关掉当前 step

### 3.4 工具调用必须“广告 → 启动 → 闭环”
`this.tools` 生命周期：
1. **广告**：`assistant/message.content` 里每个 `tool-call` part 进入 `tools`（同一 turn 内 id 不能重复）
2. **启动**：`tool/call` 的 `callId` 必须已在 `tools` 里，且 `name/arguments` 与广告块**逐字一致**
3. **闭环**：`tool/result` 的 `toolCallId` 必须对应一个“已启动”的工具；否则除非是标准
   `TOOL_NOT_STARTED` 修复格式，直接报错
4. **turn 收尾时 `tools` 必须为空**（`turn/end leaves unresolved tool call …`）
   → 历史里“有 call 没 result”的，务必补一条占位 `tool/result`

### 3.5 `session/title` 的引用
`messageSeqs` 必须指向**更早的 `user/message`**（且其 `source.kind === "user"`）；
`fallback` 标题必须非空引用，`user` 标题才允许空引用。

### 3.6 `user/message` 不需要 turn/step
`user/message` 的 data 就是消息体（无 turn/step），且不在 `STEP_EVENT_TYPES` 里，不需要开 step。

### 3.7 `system/message` 的 protected surface head（导入会话“续写即炸”的坑）
`Relationships.foldSurface`（v3→v4 迁移器与加载器同一规则）要求：
**surface 的第一个事件必须是 `system/message`** —— 它建立 `protectedHead`。之后每当
`system/message` 到达时若 `surface.length > 0 && protectedHead === undefined`，直接抛
`SessionFormatError: system/message requires a protected first surface head`。

* 原生会话的首条 surface 事件就是 system/message，永远合法
* 本管线产出的导入日志 surface 从 `user/message` 起 → **只读无恙，一旦被原生续写就整条拒载**：
  宿主恢复会话时会在新 turn 的第一步补发一条 `system/message`，恰好踩中上面的条件
  （实测 221 条导入会话全是这个形状，任何一条被续写都会中招）
* **官方修法**（dsh-chat-import 插件 ≥0.18.3，其 `convert/events.mjs` 的注释明确记录了这个 issue）：
  在**第一个 `step/start` 之后、任何 surface 事件之前**插一条**空 content** 的
  `system/message`：`surfaceOp:"append"`、`source:{kind:"system-prompt"}`、`message.id` 任意字符串。
  head 只占住 surface 第 0 节点、**不虚构提示词**（真正的提示词由宿主下一步替换或归一化）
* **自修工具**（§6）：`repair_head.mjs` = 插 head + 稠密重排 seq + 重映射全部
  `sourceEventSeqs`/`messageSeqs` 引用 + 逐帧 checksum 重打包 + loader 规则离线校验，
  失败不产出；`batch_repair_heads.mjs` 批量跑（只写 staging，不碰线上树），
  `install_head_repairs.py` 装机（flock 探测占用→跳过、备份、原子替换）

> 附带知识点：`agent/inbox/spliced` 等事件**不进 surface**（`SURFACE_TYPES` 只有
> system/message / user/message / assistant/message / tool/result 四种）。判断"会不会炸"
> 只看首条 surface 事件的类型，别被日志里其他事件的先后位置误导。

---

## 4. 迁移管线

```
源环境 state.db (只读拷贝)
  └─ extract_hermes_sessions.py   # 规范化:只取 active 消息,剔除内部控制消息
      └─ redact_secrets.py        # 脱敏(见 §5)
          ├─ hermes_to_dsh.mjs    # 编码成 v4 事件日志(每行一帧,checksum)
          └─ build_transcripts.py # 人可读逐字稿(与安装解耦的保底)
```

编码核心就是**严格遵守 §2 的事件模型和 §3 的校验规则**：
每个源消息映射成 `turn/start → step/start → user/assistant/tool → step/end → turn/end{kind:"completed"}`，
工具调用广告/启动/闭环一一对应，缺失 result 的补占位。

### 安装/对账（源环境不可写时）
若迁移方无权写目标 `$DSH_HOME`，就在工作区生成完整安装包，由用户执行：

* `install_sessions.sh` + `deploy.mjs`：**自对账**
  1. 用严格特征识别“我之前导入的会话”（v4 + 固定 4 事件前导 + 无 `request/header`/`system/message`），
     DSH 自己的会话恒有这些，绝不误删
  2. 删旧导入 → 用当前有效会话**同 ID 就地覆盖** → 收敛 `workspace.json`

> 幂等：重复跑只会覆盖，不会产生重复登记。

---

## 5. 安全与脱敏

* **源环境只读**：要分析 SQLite 就 `cp` 到临时目录再开 `mode=ro`,永不碰原库
* **脱敏**：对交付物按模式打码 —— `sk-…`、`Bearer <token>`、明文口令、`key/token/password=…`、
  以及任何高熵长 token；真实机密只留在源环境的 `.env`/凭据库里
* **教训**：脱敏脚本的扫描范围**不要包含它自己**（`.py/.js/.mjs` 不进扫描集），
  否则它会匹配到自身源码里的正则字面量、把规则改坏 —— 这个 bug 真的发生过，静默漏脱敏了一批
* **上传代码仓库前**：对目标目录单独跑一遍 PII/密钥扫描（真实姓名、ORCID、单位、项目代号、
  IP/主机/端口、`/Users/<user>/` 绝对路径、`sk-` 等），并人工复核

---

## 6. 复用

```bash
# 切分并验证一份 DSH 会话的帧结构
python3 scripts/zstd_frames.py /path/to/session.v4.jsonl.zstd

# 逐帧解码成可读 JSONL（Node 内置 zstd，无第三方依赖）
node scripts/decode_zstd_lines.js /path/to/session.v4.jsonl.zstd /tmp/session.jsonl

# 规范化 → 编码 → 严格校验
python3 scripts/zstd_frames.py /path/to/session.v4.jsonl.zstd > frames.json
NORM_DIR=./normalized OUT_DIR=./sessions SESSION_CWD="<cwd>" node scripts/hermes_to_dsh.mjs ./sessions
python3 scripts/strict_validate.py ./sessions

# 安装/对账到 DSH
DSH_HOME=~/.dsh bash scripts/install_sessions.sh

# 修复缺失的 protected surface head（§3.7）：单条
node scripts/repair_head.mjs session.v4.jsonl.zstd repaired.zstd --id <sessionId>

# 批量：发现 → 分类 → 修复 → 只写 staging（不碰线上树）
node scripts/batch_repair_heads.mjs --sessions-root "$DSH_HOME/sessions/<sanitized-cwd>" --staging ./staging

# 装机：探测 lock 占用（占用的跳过）→ 备份 → 原子替换
python3 scripts/install_head_repairs.py --staging ./staging \
    --sessions-root "$DSH_HOME/sessions/<sanitized-cwd>" --backup ./backup
```

`scripts/strict_validate.py` 复刻了 §3 的全部校验规则（含 `Relationships` 状态机）——
**在上传/安装前本地把 100% 会话跑绿，能省掉对方逐个打开才报错的来回。**
`repair_head.mjs` 内建同一套规则的校验（含 §3.7 的 protected head 规则），
校验不过**不产出文件**；批量流程刻意分成 staging + 安装两步，装之前全部本地跑绿。

### 文件

| 文件 | 作用 |
|---|---|
| `scripts/zstd_frames.py` | 按 RFC8878 切分 zstd 多帧文件，输出每帧字节区间 |
| `scripts/hermes_to_dsh.mjs` | 规范化数据 → 合法 v4 事件日志（Node 内置 zstd 逐帧压缩） |
| `scripts/strict_validate.py` | 复刻 DSH v4 校验器，离线全量体检 |
| `scripts/install_sessions.sh` / `scripts/deploy.mjs` | 自对账安装：识别并替换既有导入，收敛 workspace.json |
| `scripts/decode_zstd_lines.js` | 逐帧解码 v4 日志为 JSONL（Node zlib 只解第一帧，必须自己切） |
| `scripts/repair_head.mjs` | 修复 §3.7：插 protected head + 重排 seq + 重映射引用 + 重打包，内建校验失败不产出 |
| `scripts/batch_repair_heads.mjs` | 批量版 repair：发现 → 分类 → 修复 → staging，不碰线上树 |
| `scripts/install_head_repairs.py` | 装机：flock 探测占用跳过、备份原文件、原子替换 |

---

## 7. License

MIT，见 [LICENSE](./LICENSE)。
