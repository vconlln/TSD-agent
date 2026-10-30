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
