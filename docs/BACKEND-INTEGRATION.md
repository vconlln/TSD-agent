# 前后端对接指南（前端已写好，后端在你的内网）

> 这份文档给「只有前端源码、后端在内网不能外传」的场景准备。
> 目标：让你（以及你内网的 AI 助手）**不改一行前端代码**，就能把自己的 Python 后端接上。
>
> - 前端对外只依赖一套 **HTTP + SSE 契约**，全部类型定义在 `shared/types.ts`，全部调用点在 `src/lib/api.ts`。
> - 参照实现（可运行的 Python 后端）在 `server/`，但**你不必使用它**，只要行为对得上接口即可。
> - 想快速验证你的后端接得对不对：`node scripts/contract-check.mjs --api http://你的后端`（见 §11）。

---

## 0. 一分钟看懂整体结构

```
┌──────────────────────────────┐        ┌────────────────────────────┐
│ 前端（Electron + React）      │        │ 你的内网 Python 后端        │
│                              │  HTTP  │                            │
│  src/lib/api.ts  ────────────┼───────▶│  需要实现 §3 的 25 个接口   │
│  src/stores/*.ts 归约状态     │        │  以及 §4 的 SSE 事件流      │
│                              │  SSE   │                            │
│  /api/runs/:id/events ◀──────┼────────│  边跑边推事件               │
└──────────────────────────────┘        └────────────────────────────┘
        只认 JSON + text/event-stream，不认具体框架/语言
```

三条硬性约定：

1. **所有接口都在同一个 base URL 下**（默认 `http://127.0.0.1:8791`），路径以 `/api/` 开头；
2. **运行是异步的**：`POST .../run` 立刻返回 `runId`，真正的进度走 SSE；
3. **事件必须带单调递增的 `seq`**，前端靠它断线续传（`?since=N`）与去重。

---

## 1. 前端怎么找到你的后端

优先级从高到低（`src/lib/api.ts` 的 `resolveBase()`）：

| 顺序 | 来源 | 使用场景 |
| --- | --- | --- |
| 1 | `window.tsd.backendUrl`（Electron 主进程注入） | 内置后端 / 打包版 |
| 2 | `window.__TSD_BOOT__.apiBase` | 打包时注入的后端地址 |
| 3 | `import.meta.env.VITE_API_BASE` | 前端开发时直连内网后端 |
| 4 | `http://127.0.0.1:8791` | 默认值 |

运行时也可以在「设置 → 后端服务」里切到 **外部后端** 并填地址（保存后重启客户端生效）。

**开发模式直连内网后端**（最快的联调方式）：

```bash
# 你的后端起在 8000 端口
VITE_API_BASE=http://10.0.0.5:8000 npm run dev:renderer
```

> 浏览器直连必须让后端允许 CORS（见 §9），打包成 Electron 后不受 CORS 限制。

---

## 2. 通用约定

### 2.1 请求
- `Content-Type: application/json`；GET 无 body；
- 所有路径参数是字符串 id；
- 查询参数用 `?key=value`，路径里的值要 URL 编码。

### 2.2 响应
- 成功：`200` + JSON；无内容可返回 `204`（前端会当成 `undefined`）；
- 失败：**非 2xx**，body 里最好带 `{"detail": "人类可读的原因"}`（也接受 `error` 字段或纯文本）；前端会把这段文字直接显示给用户。

### 2.3 时间与命名
- 时间戳统一 **毫秒**（`startedAt` / `finishedAt` / `ts`）；
- JSON 字段用小驼峰（`projectId`、`targetVersion`），Python 里可以直接用 `alias` 对齐，见 §10 的 Pydantic 示例。

### 2.4 前端请求超时（别让接口卡太久）

| 接口 | 超时 |
| --- | --- |
| `GET /api/health` | 4s |
| 普通 CRUD / 设置 | 120s |
| `POST /api/projects/:id/chat`、`/apply` | 120s |
| `GET /api/projects/:id/diff` | 60s |
| `POST /api/auth/w3/login`、`GET /api/git/repos` | 45s |
| `POST /api/projects/:id/git/clone` | 600s |
| `git/publish`、`git/push`、`agent/edit` | 300s / 180s |

**长任务不要占用 HTTP 请求**：跑流水线请立刻返回 `runId`，进度用 SSE 推。

---

## 3. 接口清单（25 个）

> 「必需」列：✅ = 对应界面要用；⭕ = 可选，不实现则该界面显示降级状态但不会崩。

### 3.1 健康与设置

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok, version, engine, model, workspace, uptimeSec, platform }` | ✅ |
| GET | `/api/settings` | — | `AppSettings`（见 §6.1） | ✅ |
| PUT | `/api/settings` | `SettingsPatch`（只带要改的字段） | 更新后的 `AppSettings` | ✅ |

`engine` 字段取值 `online` / `offline`（前端标题栏状态灯、以及「离线模式」提示都用它）。

### 3.2 项目

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| GET | `/api/projects` | — | `{ projects: Project[] }` | ✅ |
| POST | `/api/projects` | `CreateProjectInput` | `Project` | ✅ |
| GET | `/api/projects/:id` | — | `Project` | ✅ |
| PATCH | `/api/projects/:id` | `Partial<Project>` | `Project` | ✅ |
| DELETE | `/api/projects/:id` | — | `204` 或 `{ok:true}` | ✅ |

`CreateProjectInput` 的最小形态：

```json
{
  "name": "订单中心",
  "sourceKind": "page",              // page | git | zip | local
  "sourceUrl": "https://plan.internal/xx.html",
  "targetVersion": "1.5.0",
  "description": "可选"
}
```

> `sourceKind=git` 时 `sourceUrl` 是仓库地址，前端还会调 `/git/clone`；
> `zip`/`local` 时 `sourceUrl` 是文件系统路径。

### 3.3 运行（升级 / 对话）

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| POST | `/api/projects/:id/run` | `{ upgradeRequest, targetVersion, referenceUrl? }` | `{ runId, run }` | ✅ |
| POST | `/api/projects/:id/chat` | `{ message, history? }` | `{ runId }` | ✅ |
| GET | `/api/runs?projectId=:id` | — | `{ runs: Run[] }`（倒序） | ✅ |
| GET | `/api/runs/:runId` | — | `Run` | ✅ |
| POST | `/api/runs/:runId/cancel` | — | `{ ok: true }` | ✅ |
| GET | `/api/runs/:runId/events?since=N` | — | `text/event-stream`（§4） | ✅ |

升级流水线的 7 个步骤 key 必须按这个顺序（前端有对应图标与文案）：

```
fetch → download → analyze → update → code → diff → finalize
```

### 3.4 文档 / 差异 / 代码 / 提案

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| GET | `/api/projects/:id/documents` | — | `{ plan:{content,path,updatedAt,exists}, update:{...} }` | ✅ |
| GET | `/api/projects/:id/diff?refresh=1` | — | `DiffPayload`（§6.3） | ✅ |
| GET | `/api/projects/:id/tree?side=source|target` | — | `{ tree, root, exists }` | ✅ |
| GET | `/api/projects/:id/file?side=&path=` | — | `{ path, content, size, language, truncated?, binary? }` | ✅ |
| POST | `/api/projects/:id/apply` | `{ proposalId }` | `{ ok, files: string[] }` | ✅ |
| DELETE | `/api/projects/:id/apply` | `{ proposalId }` | `{ ok }` | ⭕ |
| POST | `/api/projects/:id/export` | — | `{ ok, path }` | ⭕ |
| POST | `/api/projects/:id/files/write` | `{ path, content, side }` | `{ ok, size }` | ⭕ |

> `side`：`source` = 升级前的原版代码，`target` = 升级后（`{项目名}_{新版本}` 目录）。
> 前端「代码」页默认看 `target`。

### 3.5 W3 凭证与模型

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| GET | `/api/auth/w3/status` | — | `{ configured, loggedIn, user?, expiresAt? }` | ⭕ |
| POST | `/api/auth/w3/login` | `{ username, password }` | `W3Status` | ⭕ |
| POST | `/api/auth/w3/logout` | — | `{ ok }` | ⭕ |
| GET | `/api/models` | — | `{ models: [{id,label?}], source }` | ⭕ |

> 这一块是「用内网账号换访问凭证、再拿模型清单」。你要是有自己的鉴权体系，
> 只要保持同样的请求/响应形状，内部怎么实现都行（§8 有说明）。

### 3.6 Git

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| GET | `/api/git/repos?prefix=` | — | `{ repos:[{name,url,branch?,desc?}], source }` | ⭕ |
| POST | `/api/projects/:id/git/clone` | `{ url, branch? }` | `{ ok, branch, remote, files }` | ⭕ |
| GET | `/api/projects/:id/git/status` | — | `{ branch, ahead, behind, clean, changes:[...] }` | ⭕ |
| GET | `/api/projects/:id/git/branches` | — | `{ current, local:[], remote:[] }` | ⭕ |
| GET | `/api/projects/:id/git/compare?base=` | — | `{ ahead, behind, commits:[], files:[] }` | ⭕ |
| POST | `/api/projects/:id/git/publish` | `{ message, branch?, push?, createBranch? }` | `{ ok, branch, pushed, commit? }` | ⭕ |
| POST | `/api/projects/:id/git/push` | `{ branch, remote? }` | `{ ok, branch, url? }` | ⭕ |

### 3.7 编辑器内 AI

| 方法 | 路径 | 请求 | 响应 | 必需 |
| --- | --- | --- | --- | --- |
| POST | `/api/projects/:id/agent/edit` | `{ path, instruction, startLine?, endLine?, content? }` | `{ summary, rationale, replacement, patch }` | ⭕ |
| POST | `/api/projects/:id/agent/explain` | `{ path, startLine?, endLine?, content?, question? }` | `{ summary, points:[], notes? }` | ⭕ |
| GET | `/api/projects/:id/search?q=&side=` | — | `{ matches:[{path,line,text}] }` | ⭕ |

---

## 4. SSE 事件流（最容易接错的地方）

### 4.1 传输格式

```http
GET /api/runs/{runId}/events?since=0
Accept: text/event-stream
```

响应体是标准的 `text/event-stream`：

```
: connected                       ← 注释行，可选

data: {"seq":1,"runId":"r1","ts":1730000000000,"type":"run.status","data":{"status":"running"}}

data: {"seq":2,"runId":"r1","ts":1730000000100,"type":"step.status","step":"fetch","data":{"key":"fetch","title":"解析方案页面","status":"running"}}

data: [DONE]
```

### 4.2 前端的行为（你必须配合的细节）

| 前端行为 | 后端要满足 |
| --- | --- |
| `seq <= lastSeq` 的事件会被**丢弃** | `seq` 在**同一个 run 内**单调递增，从 1 开始；**不同 run 各自从 1 开始** |
| 断线后带 `?since=lastSeq` 重连，最多重试 6 次（400ms→2.5s 退避） | 必须支持 `since`：把 `seq > since` 的历史事件补发一遍 |
| 收到 `run.done` 或 `run.error` 后停止读取 | 这两个事件是**终止信号**，必须发 |
| 读不到 `[DONE]` 也能正常结束（EOF 或 `run.done` 都行） | 建议发 `data: [DONE]` 后关闭连接 |
| 运行已经结束的项目再进页面 | 事件流应能**回放**（`since=0` 把历史事件全部返回），前端靠它还原「Agent 轨迹」 |

> 实现建议：把事件同时写进 `runs/<runId>.events.jsonl`，SSE 端点先补发历史再接着推实时。
> 参照实现在 `server/tsd/events.py`（约 120 行，可以整段照抄）。

### 4.3 事件类型全表

| type | data 字段 | 用途（前端显示在哪） |
| --- | --- | --- |
| `run.status` | `{status}` | 运行状态点 |
| `step.status` | `{key,title?,status,detail?,progress?,metrics?,startedAt?,finishedAt?}` | 7 步流水线进度、指标 |
| `log` | 用顶层 `level`/`message`/`step` | 控制台日志 |
| `artifact` | `{kind,path,label?}` | 产物列表 |
| `plan.ready` | `{path,chars}` | 方案已生成 |
| `diff.ready` | `{files}` | 差异已算好（前端会重新拉 diff） |
| `agent.thought` | `{text}` | Agent 轨迹：思考 |
| `agent.tool` | `{id,tool,args,ok,durationMs,observation,preview}` | Agent 轨迹：工具调用 |
| `agent.verify` | `{command,ok,exitCode,output}` | Agent 轨迹：验证结果 |
| `chat.reasoning` | `{delta}` | 对话「思考过程」增量 |
| `chat.delta` | `{delta}` | 对话正文增量 |
| `chat.tool` | `{id,tool,args,ok,durationMs,preview,observation}` | 对话里的工具胶囊 |
| `chat.plan` | `{steps:[{title,status}]}` | 对话里的任务清单 |
| `chat.message` | `{content,proposal?,summary?,error?}` | 一条完整助手消息（**必须发**） |
| `chat.proposal` | `CodeProposal` | 单独的补丁建议（与 chat.message 二选一） |
| `run.metrics` | `{usage,model}` | token 用量 |
| `run.done` | `{summary,status?}` | **终止**；`status:"cancelled"` 表示被取消 |
| `run.error` | 用顶层 `message` | **终止**；运行标记为失败 |

**最小可用集**（先把链路跑通）：`run.status` + `step.status` + `log` + `run.done` + `run.error`。
对话再加 `chat.delta` + `chat.message`。想要「像 DeepSeek 一样」就补 `chat.reasoning` + `chat.tool`。

---

## 5. 数据模型（前端真正读取的字段）

完整定义见 `shared/types.ts`（如果你只会读一份文件，就读它）。下面只列**前端会用到**的字段和容易踩的坑。

### 5.1 Project
```ts
{ id, name, slug, baseVersion, targetVersion,
  status: 'draft'|'running'|'ready'|'failed',
  createdAt, updatedAt,            // 毫秒
  workspace: string,               // 工作目录（会显示在页头）
  sourceUrl?, sourceKind?, planPath?, updatePath?, sourceDir?, targetDir?,
  stats?: { files, added, removed, sections, filesChanged? },
  description?, tags?, error?, lastRunId? }
```
- `slug` 只用于显示与目录名，没有就让后端生成；
- `status` 影响「重新执行」按钮是否可用，跑完记得改成 `ready`。

### 5.2 Run / RunStep
字段见 §3.3 与 `shared/types.ts`。两个坑：

1. `steps` 数组**必须**在创建 run 时就带上 7 个 pending 步骤（否则刷新后进度条是空的）；
2. 每次 `step.status` 事件，**同时把状态写回 run 记录**（`runs/<runId>.json`），
   这样 `GET /api/runs/:id` 拿到的才不是旧数据——前端刷新页面只看这个接口。

### 5.3 DiffPayload
```ts
{ projectId, generatedAt,
  plan:  { unified, sections:[{key,heading,level,status,oldText?,newText?,summary?}], additions, deletions },
  files: [{ path, oldPath?, status:'added'|'modified'|'deleted'|'renamed', additions, deletions, patch, binary?, truncated? }],
  stats: { files, added, removed, filesChanged } }
```
- `patch` 是**统一差异文本**（`--- a/x` / `+++ b/x` / `@@` 头 + `+/- ` 行），前端自己解析成行、配对、词级高亮；
- 大文件可以设 `truncated: true`，前端会折叠提示；
- 二进制文件设 `binary: true`、`patch: ""`。

### 5.4 CodeProposal（对话里的「代码修改建议」）
```ts
{ id, summary, rationale?, applied?, discarded?,
  edits: [{ path, before, after, patch?, additions, deletions }] }
```
- `before` 是当前磁盘内容，`after` 是建议内容，`patch` 由后端算；
- **提案不要直接落盘**，等前端调 `POST /apply` 再写；
- 前端会把 `patch` 渲染成增删行，所以 `patch` 为空时界面会显示「0 变化」——记得真的算。

---

## 6. 降级矩阵（哪些接口可以先不做）

前端对每个可选能力都有降级，不会因为少一个接口就白屏：

| 缺什么 | 界面表现 |
| --- | --- |
| `/api/diff` | 「差异」页显示空状态，其他页正常 |
| `/api/tree` / `/file` | 「代码」页提示无法读取，编辑器不可用 |
| `/api/runs/:id/events` | 进度条不动、日志空、对话不出字（**别省这个**） |
| `chat.*` 事件 | 对话只显示最终 `chat.message`（退化成「一次性回答」） |
| Git 全套 | 「仓库」页显示「未配置 Git」 |
| `/api/auth/w3/*` | 设置页显示演示模式提示 |
| `/api/agent/edit|explain` | 编辑器里「修改/解释」按钮报错禁用 |

> 「工作台、项目库、项目概览、流水线、差异、对话」这 5 块是最小闭环，
> 对应 §3.1 + §3.2 + §3.3 + `documents` + `diff`。

---

## 7. 三种接入姿势（按你的实际情况选）

### 姿势 A：适配层（推荐，不动现有后端语义）
在你现有服务里加一个 **`/tsd` 路由前缀**的适配层，把内部 API 映射成套契约：

```python
# 你的服务里新增 tsd_adapter.py（照 §10 的骨架改）
@app.get("/tsd/api/projects")
async def list_projects():
    rows = await your_internal.list_projects()      # 你自己的实现
    return {"projects": [to_contract(p) for p in rows]}   # 只做字段映射
```
然后把前端 `VITE_API_BASE` 指到 `http://内网地址/tsd`。
好处：内部实现随便改，契约稳定；坏处：多一层。

### 姿势 B：字段映射函数（最省事）
如果内部 API 的形状已经接近，只写 `to_contract_*()` 系列纯函数，路由直接转调：

```python
def to_contract_project(row) -> dict:
    return {
        "id": row["proj_id"],
        "name": row["proj_name"],
        "slug": row.get("slug") or slugify(row["proj_name"]),
        "baseVersion": row.get("version_from", "1.0.0"),
        "targetVersion": row.get("version_to", "1.0.0"),
        "status": MAP_STATUS[row["state"]],
        "createdAt": int(row["gmt_create"] * 1000),   # 秒 → 毫秒
        "updatedAt": int(row["gmt_modified"] * 1000),
        "workspace": row["work_dir"],
    }
```

### 姿势 C：先用参照实现跑通，再逐块替换
`npm run seed:demo` + `npm start` 先把前端跑起来，然后按 §3 的表一块块把地址切到你的服务。
每换一块就跑一次 `node scripts/contract-check.mjs`。

---

## 8. 鉴权怎么接

前端**不直接**处理你的鉴权体系，它只做两件事：

1. 调 `/api/auth/w3/login` 传用户名密码，后端自己决定怎么换凭证（前端只拿到 `W3Status`）；
2. 之后所有请求**由后端带自己的凭证**去访问内部服务（前端不接触 token）。

所以：

- 如果你的内网服务需要 `Authorization`，请在后端内部完成；
- 如果前端必须带 token，就在 `src/lib/api.ts` 的 `request()` 里统一加 header（一处改动，所有接口生效）；
- 敏感信息（密码 / token）**不要回传前端**，`AppSettings.engine.apiKeySet` 那种「只回布尔」的做法可以直接照抄。

---

## 9. CORS 与本地开发

浏览器直连（`npm run dev:renderer`）需要你的后端允许跨域：

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5273", "http://127.0.0.1:5273"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

打包成 Electron 后是 `file://` 加载渲染进程，走的是原生 fetch，**不受 CORS 限制**；
但 SSE 仍然是普通 HTTP 请求，同样需要后端允许（Electron 里没影响）。

另外：**回环地址（127.0.0.1/localhost）不要走系统代理**，否则企业代理会把请求拦掉。
参照实现在 `server/tsd/parser.py` 的 `use_env_proxy()` 里处理了。

---

## 10. 后端骨架（Pydantic 版，可直接改）

```python
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

class HealthOut(BaseModel):
    ok: bool = True
    version: str
    engine: str            # online | offline
    model: str = ""
    workspace: str
    uptimeSec: float = 0
    platform: str

class ProjectOut(BaseModel):
    id: str
    name: str
    slug: str
    baseVersion: str = Field(alias="baseVersion")
    targetVersion: str
    status: str            # draft | running | ready | failed
    createdAt: int
    updatedAt: int
    workspace: str
    stats: dict | None = None
    class Config:
        populate_by_name = True

@app.get("/api/health")
async def health() -> HealthOut: ...

@app.post("/api/projects/{pid}/run")
async def start_run(pid: str, body: RunIn):
    run_id = await your_pipeline.start(pid, body.upgradeRequest)
    return {"runId": run_id, "run": await load_run(run_id)}   # 立刻返回，别等跑完

@app.get("/api/runs/{rid}/events")
async def events(rid: str, since: int = 0):
    async def gen():
        async for event in your_event_hub.subscribe(rid, since):   # 先补发历史，再推实时
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```

> `X-Accel-Buffering: no` 很重要：否则 Nginx 会缓冲 SSE，前端要等到结束才收到事件。

---

## 11. 用工具验证你的后端（强烈建议）

```bash
node scripts/contract-check.mjs --api http://10.0.0.5:8000
# 只读模式：不创建项目、不触发运行
node scripts/contract-check.mjs --api http://10.0.0.5:8000 --read-only
# 输出机器可读报告
node scripts/contract-check.mjs --api http://10.0.0.5:8000 --json > report.json
```

它会逐条检查：路径是否存在、状态码是否 2xx、JSON 形状是否对得上（缺失字段会点名），
最后按「必需 / 可选」分类给出一份可执行的待办清单。适合每接一块就跑一次。

---

## 12. 常见的「接上但不对」现象对照表

| 现象 | 八成原因 |
| --- | --- |
| 进度条一直空着 | `create_run` 时 `steps` 是空数组 |
| 刷新页面进度回到 0 | `step.status` 只推事件，没写回 `run.json` |
| 对话气泡一直「生成中」 | 没发 `chat.message`，或 `seq` 从别的 run 续上了 |
| 文字变成一坨 / 没有格式 | `chat.delta` 里塞了整段 JSON，或 `content` 里是转义过的字符串 |
| 事件重复出现两遍 | `since` 没生效（History 全量重发但 `seq` 又从头开始） |
| 差异页空白 | `patch` 不是统一差异格式（缺 `@@` 头前端解析不出来） |
| 中文乱码 | SSE 没设 `charset=utf-8`，或响应体用了 `ensure_ascii=True` |
| 点「应用」没反应 | `/apply` 没真正写盘，或返回体里没有 `ok: true` |
| 设置页读不到配置 | `/api/settings` 少了 `agent`/`git`/`w3` 任一区块（前端有兜底但会显示默认值） |

---

## 13. 一页速查

```
必需（最小闭环）:
  GET  /api/health
  GET/PUT /api/settings
  GET/POST /api/projects, GET/PATCH/DELETE /api/projects/:id
  POST /api/projects/:id/run       → {runId, run}
  GET  /api/runs?projectId=        → {runs}
  GET  /api/runs/:id               → Run（steps 必须写回）
  POST /api/runs/:id/cancel
  GET  /api/runs/:id/events?since= → SSE（seq 单调递增 + [DONE]）
  GET  /api/projects/:id/documents
  GET  /api/projects/:id/diff
  POST /api/projects/:id/chat      → {runId}（再接 chat.delta + chat.message）

三条铁律:
  1) 长任务立刻返回 runId，进度走 SSE
  2) seq 按 run 隔离、单调递增、支持 since 回放
  3) 事件里别塞二进制/超长内容，observation 截到 ~4000 字符
```
