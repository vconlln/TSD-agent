# 后端 API 契约 v1

前端只依赖本文件描述的 HTTP + SSE 接口。你可以用任何语言重写后端，只要满足以下契约，
在「设置 → 后端服务」里切换为 **外部后端** 并填入地址即可。

- 默认地址：`http://127.0.0.1:8791`（内置模式由 Electron 动态分配端口）
- 编码：UTF-8，JSON（`Content-Type: application/json`）
- 跨域：外部后端需允许 `Access-Control-Allow-Origin: *`（或用 `CORSMiddleware`）
- 错误：非 2xx 时返回 `{"detail": "错误说明"}`，前端会把 `detail` 展示出来
- 时间戳：毫秒级 Unix 时间（number）

---

## 1. 健康检查

### `GET /api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "engine": "online",
  "model": "deepseek-chat",
  "workspace": "/home/user/.config/TSD Agent/workspace",
  "uptimeSec": 42.5,
  "platform": "win32"
}
```

`engine` 为 `online` | `offline`。前端每 8 秒轮询一次，用于标题栏状态灯与连接门禁。

---

## 2. 设置

### `GET /api/settings`

```json
{
  "engine": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeySet": true,
    "temperature": 0.3,
    "maxTokens": 8192,
    "timeoutSec": 300,
    "offlineMode": false
  },
  "workspace": "/path/to/workspace",
  "concurrency": 2,
  "autoApplyChatEdits": false,
  "language": "zh-CN"
}
```

> 出于安全考虑**永远不要**把 API Key 回传给前端，只返回 `apiKeySet: boolean`。

### `PUT /api/settings`

请求体可只带需要修改的字段；`engine.apiKey` 为写专用字段（留空表示不修改）：

```json
{
  "engine": { "model": "deepseek-reasoner", "apiKey": "sk-...", "temperature": 0.2 },
  "autoApplyChatEdits": false
}
```

返回更新后的完整设置对象。

---

## 3. 项目

### 数据模型

```ts
interface Project {
  id: string
  name: string
  slug: string
  sourceUrl?: string
  sourceKind?: 'page' | 'git' | 'zip' | 'local'
  baseVersion: string          // 原始版本，例如 "1.4.0"
  targetVersion: string        // 目标版本，例如 "1.5.0"
  status: 'draft' | 'running' | 'ready' | 'failed'
  createdAt: number
  updatedAt: number
  workspace: string            // 项目根目录绝对路径
  planPath?: string            // plan/PLAN.md
  updatePath?: string          // plan/UPDATE.md
  sourceDir?: string           // 原版代码目录
  targetDir?: string           // 升级后代码目录
  lastRunId?: string
  stats?: { files: number; added: number; removed: number; sections: number; filesChanged?: number }
  error?: string
  tags?: string[]
  description?: string
}
```

### `GET /api/projects`

```json
{ "projects": [ /* Project[]，按 updatedAt 倒序 */ ] }
```

### `POST /api/projects`

```json
{
  "name": "订单中心",
  "sourceUrl": "https://example.com/plan",
  "sourceKind": "page",
  "targetVersion": "1.5.0",
  "description": "可选说明"
}
```

返回 `Project`。

### `GET /api/projects/{id}`

返回 `Project`；不存在时 404。

### `PATCH /api/projects/{id}`

可更新：`name`、`description`、`targetVersion`、`baseVersion`、`tags`、`status`。

### `DELETE /api/projects/{id}`

```json
{ "ok": true }
```

---

## 4. 运行（升级 / 对话）

### 运行模型

```ts
interface RunStep {
  key: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
  startedAt?: number
  finishedAt?: number
  progress?: number            // 0-100
  metrics?: Record<string, number | string>
}

interface Run {
  id: string
  projectId: string
  kind: 'upgrade' | 'chat'
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  prompt?: string
  startedAt: number
  finishedAt?: number
  steps: RunStep[]
  error?: string
  summary?: string
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
}
```

升级流程的步骤键（顺序固定，前端有对应图标）：

| key | 标题 |
| --- | --- |
| `fetch` | 解析方案页面 |
| `download` | 下载基础代码 |
| `analyze` | 分析项目结构 |
| `update` | 生成升级方案（UPDATE.md） |
| `code` | 升级代码 |
| `diff` | 计算差异 |
| `finalize` | 整理结果 |

对话运行的步骤：`context` / `reason` / `patch`。

### `POST /api/projects/{id}/run`

```json
{
  "upgradeRequest": "把鉴权升级为 JWT，并补充刷新令牌接口",
  "targetVersion": "1.5.0",
  "referenceUrl": "https://github.com/u/r.git"
}
```

立即返回，任务在后台执行：

```json
{ "runId": "ab12cd34ef56", "run": { /* Run */ } }
```

已有运行中的任务时返回 `409`。

### `POST /api/projects/{id}/chat`

```json
{ "message": "把登录改成 JWT 并补充测试", "conversationId": "可选" }
```

```json
{ "runId": "..." }
```

### `GET /api/runs?projectId={id}`

```json
{ "runs": [ /* Run[]，按 startedAt 倒序 */ ] }
```

### `GET /api/runs/{runId}`

返回 `Run`。

### `POST /api/runs/{runId}/cancel`

```json
{ "ok": true }
```

---

## 5. 事件流（SSE）

### `GET /api/runs/{runId}/events?since={seq}`

- `Content-Type: text/event-stream`
- 每帧：`data: {JSON}\n\n`
- 以 `since` 回放历史事件（`seq > since`），随后增量推送
- 心跳：`": ping\n\n"`（15 秒一次，前端忽略）
- 结束：发出 `data: [DONE]\n\n`（发生 `run.done` / `run.error` 之后）
- **必须支持断线重连**：客户端会用最后收到的 `seq` 重新请求

### 事件结构

```ts
interface AgentEvent {
  seq: number           // 单调递增，重连依据
  runId: string
  ts: number            // 毫秒时间戳
  type:
    | 'run.status' | 'step.status' | 'log'
    | 'artifact' | 'plan.ready' | 'diff.ready'
    | 'chat.delta' | 'chat.message' | 'chat.proposal'
    | 'run.metrics' | 'run.done' | 'run.error'
  step?: string         // 关联步骤 key
  level?: 'debug' | 'info' | 'warn' | 'error' | 'success'
  message?: string      // log / run.error 的文本
  delta?: string        // chat.delta 的增量文本
  data?: Record<string, unknown>
}
```

| type | data 字段 | 说明 |
| --- | --- | --- |
| `run.status` | `{ status }` | 运行状态变化 |
| `step.status` | `{ key, title?, status, detail?, progress?, metrics?, startedAt?, finishedAt? }` | 步骤状态 |
| `log` | — | 用 `level` / `message` / `step` |
| `plan.ready` | `{ path, chars }` | 方案文档生成完毕 |
| `diff.ready` | `{ files }` | 差异计算完毕 |
| `chat.delta` | — | 用 `delta` 字段，增量文本 |
| `chat.message` | `{ content, proposal?, summary?, error? }` | 一条完整的助手消息 |
| `chat.proposal` | `CodeProposal` | 单独推送补丁建议（可与 chat.message 二选一） |
| `run.metrics` | `{ usage, model }` | token 用量等 |
| `run.done` | `{ summary, status? }` | 成功结束（`status: "cancelled"` 表示取消） |
| `run.error` | — | 用 `message`，前端把运行标记为失败 |

示例：

```
data: {"seq":1,"runId":"r1","ts":1730000000000,"type":"run.status","data":{"status":"running"}}

data: {"seq":2,"runId":"r1","ts":1730000000100,"type":"step.status","step":"fetch","data":{"key":"fetch","title":"解析方案页面","status":"running"}}

data: {"seq":3,"runId":"r1","ts":1730000000200,"type":"log","level":"info","step":"fetch","message":"抓取方案页面：https://..."}

data: [DONE]
```

---

## 6. 文档与差异

### `GET /api/projects/{id}/documents`

```json
{
  "projectId": "p1",
  "plan":   { "content": "# ...", "path": "/abs/plan/PLAN.md",   "updatedAt": 1730000000000, "exists": true },
  "update": { "content": "# ...", "path": "/abs/plan/UPDATE.md", "updatedAt": 1730000000000, "exists": true }
}
```

### `GET /api/projects/{id}/diff?refresh=1`

```ts
interface DiffPayload {
  projectId: string
  generatedAt: number
  plan: {
    unified: string              // PLAN.md vs UPDATE.md 的统一差异
    sections: PlanSectionDiff[]  // 章节级差异
    additions: number
    deletions: number
  }
  files: DiffFile[]
  stats: { files: number; added: number; removed: number; filesChanged: number }
}

interface PlanSectionDiff {
  key: string
  heading: string
  level: number
  status: 'added' | 'removed' | 'modified' | 'unchanged'
  oldText?: string
  newText?: string
}

interface DiffFile {
  path: string                   // 相对路径
  oldPath?: string               // 重命名时的旧路径
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  patch: string                  // 标准 unified diff（--- +++ @@ 格式）
  binary?: boolean
  truncated?: boolean
  language?: string
}
```

`patch` 必须能被标准解析器读取，例如：

```diff
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
 import express from 'express'
-export const token = 'session'
+import jwt from 'jsonwebtoken'
+export const token = 'jwt'
```

### `GET /api/projects/{id}/tree?side=source|target`

```ts
interface TreeNode {
  name: string
  path: string                   // 相对路径，根为 ""
  type: 'file' | 'dir'
  size?: number
  status?: 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged'
  children?: TreeNode[]
}

// 响应
{ "tree": TreeNode | null, "root": "/abs/path", "exists": true }
```

### `GET /api/projects/{id}/file?side=source|target&path={rel}`

```json
{
  "path": "src/server.ts",
  "content": "...",
  "size": 1234,
  "language": "ts",
  "truncated": false,
  "binary": false
}
```

- 必须做路径越界防护（禁止 `..`、绝对路径）
- 建议大于 1.5 MB 时截断并置 `truncated: true`

---

## 7. 对话补丁

### `CodeProposal`

```ts
interface CodeProposal {
  id: string
  summary: string
  rationale?: string
  edits: Array<{
    path: string
    before: string
    after: string
    patch: string
    additions: number
    deletions: number
  }>
  applied?: boolean
  discarded?: boolean
}
```

### `POST /api/projects/{id}/apply`

```json
{ "proposalId": "abc123" }
```

把 `edits[].after` 写入**升级后目录**，并重算差异。

```json
{ "ok": true, "files": ["src/auth.ts"] }
```

### `DELETE /api/projects/{id}/apply`

同上请求体，标记为忽略，返回 `{ "ok": true }`。

---

## 8. 其他

### `POST /api/projects/{id}/export`

打包项目产物（方案 + 升级后代码 + diff.json）为 zip：

```json
{ "ok": true, "path": "/abs/exports/order-center-v1.5.0-20260101-120000.zip" }
```

### `GET /api/projects/{id}/search?q={keyword}&side=target`

```json
{ "results": [ { "path": "src/auth.ts", "size": 1200, "reason": "content" } ] }
```

---

## 9. 工作区目录约定

```
<workspace>/
├── .tsd/config.json            # 后端自身配置（含 API Key）
├── projects/<projectId>/
│   ├── project.json            # Project 元数据
│   ├── plan/PLAN.md
│   ├── plan/UPDATE.md
│   ├── source/                 # 原版代码
│   ├── v1.5.0/                 # 升级后代码（目录名 = targetVersion）
│   ├── diff.json               # 差异缓存
│   ├── proposals.json          # 对话补丁
│   └── runs/<runId>.json|.events.jsonl
├── runs/<runId>.events.jsonl   # 事件持久化（用于回放/续传）
└── exports/
```

后端启动参数（内置模式由 Electron 传入）：

```bash
python server/main.py --host 127.0.0.1 --port 8791 --workspace /path/to/workspace
```


---

## 10. W3 访问凭证与模型

内网 W3 网关地址属于部署细节，前端只依赖以下契约。**未配置网关时后端进入演示模式**：
任意用户名 + 4 位以上密码即可签发本地演示凭证，返回内置模型清单，便于先打通前端联调。

### `POST /api/auth/w3/login`

```json
{ "username": "alice", "password": "********" }
```

响应：

```ts
interface W3Status {
  authenticated: boolean
  configured: boolean          // 后端是否配置了真实网关
  mode: 'w3' | 'demo'
  user?: { id?: string; name?: string; email?: string; department?: string }
  expiresAt?: number
  tokenPreview?: string        // 只回传摘要，完整凭证留在后端
  rememberUsername?: string
  models: W3Model[]
  suggestedEngine?: { baseUrl?: string; apiKey?: string; model?: string }  // 可选：让前端一键写入引擎配置
}

interface W3Model {
  id: string
  name: string
  provider?: string
  contextWindow?: number
  tags?: string[]
  recommended?: boolean
}
```

错误：`400` 参数不合法、`401` 账号或密码错误、`502` 网关不可用。

真实网关模式下后端转发到 `{w3.serverUrl}{w3.loginPath}`（默认 `/api/v1/auth/login`）：
请求体 `{"username","password"}`，期望返回 `{token | accessToken, expiresIn?, user | profile}`。

### `GET /api/auth/w3/status`

返回当前 `W3Status`；凭证过期会自动清除。

### `POST /api/auth/w3/logout`

```json
{ "ok": true }
```

### `GET /api/models`

```ts
interface ModelsResult {
  models: W3Model[]
  source: 'w3' | 'builtin'
}
```

模型清单来自 `{w3.serverUrl}{w3.modelsPath}`（默认 `/api/v1/models`，Bearer 凭证）。
真实网关解析失败或未登录时返回内置清单。

> 安全约定：密码只在登录请求中出现，**永远不落盘、不回传**；凭证只保存在本机工作区配置中。

---

## 11. Git 集成

```
项目/
├── source/           ← git 工作区（克隆时保留 .git，差异计算会跳过它）
├── v1.5.0/           ← 升级后的代码快照（不含 .git）
└── plan/UPDATE.md
```

### 仓库检索

#### `GET /api/git/repos?prefix=mic`

按名称前缀检索仓库。`provider` 由设置决定：

| provider | 行为 |
| --- | --- |
| `local`（默认） | 扫描 `git.reposRoot`（默认 `<workspace>/repos`）下的目录；识别工作区仓库与裸仓库 |
| `gitlab` | `GET {baseUrl}/api/v4/projects?search=&simple=true`，`PRIVATE-TOKEN` |
| `github` | `GET {baseUrl 或 https://api.github.com}/search/repositories?q=<prefix> in:name` |
| `generic` | `GET {baseUrl}{reposPath}?search=&prefix=`，返回 `{items|data|repos}` |

```ts
interface GitReposResult {
  provider: string
  prefix: string
  repos: Array<{
    name: string
    fullName?: string
    url: string            // 可直接用于克隆（HTTPS / SSH / 本地路径）
    path?: string
    description?: string
    defaultBranch?: string
    updatedAt?: number
    provider: string
  }>
  note?: string            // 远程不可用时的回退说明
}
```

### 克隆

#### `POST /api/projects/{id}/git/clone`

```json
{ "url": "https://git.example.com/group/micabc.git", "branch": "main" }
```

克隆到 `source/`（保留 `.git` 与 `origin`）。本地目录若不是 Git 仓库，会自动
`git init` 并提交一次初始版本。

```json
{ "ok": true, "branch": "main", "remote": "https://…", "files": 128, "baseVersion": "1.4.0" }
```

### 状态 / 分支 / 对比

#### `GET /api/projects/{id}/git/status`

```ts
interface GitStatusInfo {
  initialized: boolean
  repoDir?: string
  gitAvailable?: boolean
  branch?: string
  upstream?: string
  remoteUrl?: string
  remotes?: Array<{ name: string; url: string }>
  ahead?: number
  behind?: number
  dirty?: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' }>
  lastCommit?: { sha: string; message: string; author: string; date: string } | null
}
```

#### `GET /api/projects/{id}/git/branches`

```ts
interface GitBranchInfo {
  current: string
  local: Array<{ name: string; sha: string; date: string; subject: string }>
  remote: Array<{ name: string; sha: string; date: string; subject: string }>
}
```

#### `GET /api/projects/{id}/git/compare?base=origin/main`

先 `git fetch --all --prune`（失败不致命），再对比基准分支。基准解析顺序：
`base` 参数 → `@{u}` → `origin/<当前分支>` → `origin/<默认分支>` → `origin/HEAD`。

```ts
interface GitCompareResult {
  ok: boolean
  reason?: 'no-base'
  base?: string
  branch?: string
  fetched?: boolean
  ahead?: number
  behind?: number
  commits?: Array<{ sha: string; subject: string }>   // 本地领先的提交
  incoming?: Array<{ sha: string; subject: string }>  // 远程领先的提交
  files?: Array<{ status: string; path: string }>
}
```

### 提交与推送

#### `POST /api/projects/{id}/git/publish`

把升级结果中**差异涉及的文件**同步进 Git 工作区，新建/切换分支后提交，可选推送。

```json
{
  "message": "feat: upgrade to v1.5.0",
  "branch": "upgrade/v1.5.0",
  "push": true,
  "remote": "origin",
  "createBranch": true,
  "force": false
}
```

- 工作区有未提交改动且 `force=false` → 返回 `{ ok: false, reason: "worktree-dirty", dirty: [...] }`
- 没有需要提交的改动 → `{ ok: false, reason: "no-changes" }`
- 推送失败 → `{ ok: false, reason: "push-failed", error: "<stderr>" }`（本地提交保留）

成功：

```json
{
  "ok": true,
  "branch": "upgrade/v1.5.0",
  "sha": "86ad7fe",
  "pushed": true,
  "remote": "origin",
  "url": "https://git.example.com/group/micabc/-/tree/upgrade%2Fv1.5.0",
  "files": [{ "path": "src/index.ts", "status": "modified" }]
}
```

#### `POST /api/projects/{id}/git/push`

```json
{ "branch": "upgrade/v1.5.0", "remote": "origin" }
```

### Git 设置（`PUT /api/settings`）

```json
{
  "git": {
    "provider": "gitlab",
    "baseUrl": "https://git.example.internal",
    "token": "glpat-…",
    "reposPath": "/api/v4/projects",
    "reposRoot": "/srv/repos",
    "defaultBranch": "main",
    "authorName": "TSD Agent",
    "authorEmail": "tsd-agent@localhost"
  }
}
```

Token 只写不读（`GET /api/settings` 返回 `tokenSet: boolean`），会用于 HTTPS 推送的
`http.extraheader=Authorization: Bearer …`。

---

## 12. 编辑器内 AI（行内修改 / 解释）

前端把编辑器里**当前内容**（可能尚未保存）连同选区一起发送，后端只让模型回答
「替换选区的代码文本」，再用 `difflib` 生成补丁供前端展示接受 / 拒绝。

### `POST /api/projects/{id}/agent/edit`

```json
{
  "path": "src/index.ts",
  "instruction": "把这段校验抽成独立函数并补充注释",
  "startLine": 12,
  "endLine": 24,
  "content": "…当前编辑器内容（可选）…"
}
```

- `startLine/endLine` 省略或为 0 → 整文件重写
- 选区上限 400 行、文件上限 200k 字符

成功：

```ts
interface InlineEditResult {
  ok: true
  mode: 'llm' | 'offline'
  model?: string
  path: string
  scope: 'selection' | 'file'
  startLine: number
  endLine: number
  summary: string
  rationale?: string
  replacement: string   // 替换选区的代码文本
  before: string
  after: string
  patch: string         // 标准 unified diff
  additions: number
  deletions: number
}
```

未配置模型时返回 `200` + `{ ok: false, mode: "offline", error: "未配置可用的推理引擎…" }`，
前端直接提示，不会写入任何文件。

### `POST /api/projects/{id}/agent/explain`

```json
{ "path": "src/index.ts", "startLine": 1, "endLine": 30, "content": "…", "question": "这段并发安全吗" }
```

```ts
interface ExplainResult {
  ok: true
  mode: 'llm' | 'offline'
  model?: string
  text: string          // Markdown
  path: string
}
```

未配置模型时返回**结构化静态分析**（依赖、类、函数、导出清单），而不是报错。

---

## 13. 文件写回（编辑器保存）

### `POST /api/projects/{id}/files/write`

```json
{ "path": "src/index.ts", "content": "…", "side": "target" }
```

- 只允许升级目录（`side=target`）或原版目录（`side=source`）
- 拒绝路径穿越、二进制文件、超过 2 MB 的内容
- 写入后自动刷新 `diff.json`

```json
{ "ok": true, "path": "src/index.ts", "size": 1234, "updatedAt": 1730000000000 }
```
