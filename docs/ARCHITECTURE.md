# 架构说明

## 1. 总览

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron 主进程 (electron/)                                      │
│   main.ts        窗口 / IPC / 生命周期                            │
│   backend.ts     BackendSupervisor：端口分配、进程守护、健康检查   │
│   config.ts      userData/tsd-config.json 读写                    │
│   preload.ts     contextBridge → window.tsd                       │
└──────────────┬──────────────────────────────┬───────────────────┘
               │ IPC                          │ HTTP + SSE
┌──────────────▼───────────────┐  ┌───────────▼──────────────────┐
│ 渲染进程 (src/)               │  │ Python 后端 (server/)         │
│   React 18 + Vite             │  │   FastAPI                     │
│   Zustand（app/projects/      │  │   /api/*      REST            │
│   session）                   │  │   /api/runs/:id/events  SSE   │
│   Tailwind + Radix + CSS 变量 │  │   UpgradePipeline / ChatAgent │
│   Shiki（按需加载）            │  │   LLMClient（OpenAI 兼容）     │
└──────────────────────────────┘  └───────────┬──────────────────┘
                                              │
                                   workspace/projects/<id>/
```

前端不直接接触文件系统与进程：窗口能力走 IPC，业务能力走 HTTP。两者都可以替换。

---

## 2. 进程与生命周期

1. **启动**：`app.whenReady` → 读取配置 → 创建无边框窗口 → 若 `autoStart` 则调用
   `BackendSupervisor.start()`。
2. **选择后端**：
   - `backendMode = external`：直接使用配置的 URL。
   - `embedded`：按顺序查找 `resources/backend/tsd-server/tsd-server(.exe)` →
     `backend-dist/` → `server/main.py`（需系统 Python）。
3. **端口**：`net.createServer().listen(0)` 取空闲端口，通过 `--port` 传给后端，
   同时把 `--workspace` 指到 `userData/workspace`。
4. **健康检查**：轮询 `/api/health`（最长 45s），成功后向渲染进程广播
   `backend:status`，前端解除连接门禁。
5. **进程退出**：`before-quit` → SIGTERM → 2.5s 后 SIGKILL。异常退出会自动重启一次。

渲染进程在服务启动期间显示连接门禁，并保留最后 8 行后端日志便于排障。

---

## 3. 前端状态模型

```
useAppStore      外观（主题/明暗/密度/圆角/特效）、后端状态、健康信息   ← 持久化到 localStorage
useProjectsStore 项目列表与 CRUD
useSessionStore  按项目组织的运行时：runs[] / events[] / logs[] / chat[] / documents / diff / trees / files
```

### 事件 → 状态的归约

`src/stores/session.ts` 里 `handleEvent` 是唯一的事件消费者：

| 事件 | 归约动作 |
| --- | --- |
| `step.status` | 按 `key` upsert 步骤（状态、进度、耗时、指标） |
| `run.status` / `run.metrics` | 更新运行状态与 token 用量 |
| `log` | 追加到日志环形缓冲（上限 1200 行） |
| `chat.delta` | 追加到 `assistant-<runId>` 消息（打字机效果） |
| `chat.message` / `chat.proposal` | 落地完整消息与补丁建议，并持久化对话到 localStorage |
| `run.done` / `run.error` | 标记结束 + 刷新文档、差异、项目、文件树 |

SSE 客户端（`src/lib/api.ts` 的 `streamRunEvents`）：
- 用 `since=seq` 续传，事件永不重复消费；
- 断线指数退避重连（最多 6 次）；
- 收到 `[DONE]` 或 `run.done`/`run.error` 立即停止。

### 性能取舍

- 路由级 `AnimatePresence` 只切换内容，侧边栏与标题栏不重挂载。
- Shiki 高亮器是**独立 chunk**，只在首次渲染代码时加载；语言集显式裁剪
  （约 1MB，而不是完整 9MB 包）。
- 大差异：单文件超过 1600 行时折叠，可手动展开；补丁超过 6MB 时后端停止收集。
- 文件内容按 `side:path` 缓存，切换文件不重复请求。

---

## 4. 后端流水线

`server/tsd/pipeline.py` 的 `UpgradePipeline.run` 按顺序执行 7 步，
每步都会向 `RunChannel` 写 `step.status` / `log`：

```
fetch     抓取方案 URL → html_to_markdown → PLAN.md（同时发现代码链接）
download  git clone / zip 下载 / 本地复制 → source/（失败则生成脚手架）
analyze   walk_files → 语言分布、关键文件、内容节选 → inventory
update    LLM 或离线模板 → UPDATE.md
code      copy_tree(source → v{target}) → LLM/离线改动写入
diff      difflib 生成统一补丁 + 章节级方案差异 → diff.json
finalize  更新 project.json（状态、统计）+ run.done
```

**可取消**：每个阶段之间检查 `run.cancelRequested`，命中即抛 `Cancelled`，
运行标记为 `cancelled`，项目回到 `draft`。

**降级策略**：
- 无 API Key / 模型报错 → 离线启发式：结构化 UPDATE.md、版本号提升、
  CHANGELOG / UPGRADE_NOTES / 迁移脚本、README 追加升级记录。
- 页面解析失败 → 记录错误并继续；
- 代码下载失败 → 生成最小脚手架，保证后续步骤可执行。

### LLM 适配层

`server/tsd/llm.py` 只依赖 OpenAI 兼容的 `/chat/completions`：
`baseUrl + /chat/completions`，`Authorization: Bearer <key>`。
支持 `response_format: json_object`（不支持时自动回退并在文本中提取 JSON）。

---

## 5. 差异计算

后端（`diffing.py`）：
1. `walk_files` 忽略 `.git/node_modules/dist/...`；
2. 逐文件比较大小 + SHA1，相同即跳过；
3. 用 `difflib.unified_diff` 生成补丁（`--- ` / `+++ ` / `@@`），
   统计 `+/- ` 行数；
4. 内容相同的「删除 + 新增」合并为 `renamed`；
5. 章节级方案差异按 Markdown 标题切分，标记 added/modified/removed/unchanged。

前端（`src/lib/diff.ts`）：
1. 解析统一补丁为 `hunks → rows`（保留新旧行号）；
2. 相邻的 `-` / `+` 行成对做**词级 diff**（`diffWordsWithSpace`）；
3. 并排布局把 rows 配对成左右两列；
4. 语法着色：按「同类型连续行」分组交给 Shiki，再按行回填 token。

---

## 6. 目录约定

- 每个项目一个目录：`workspace/projects/<projectId>/`
- 版本目录名即目标版本：`v1.5.0/`
- 所有运行记录：`projects/<id>/runs/<runId>.json` + `runs/<runId>.events.jsonl`
  （事件同时写入全局 `workspace/runs/` 供回放）
- 对话补丁：`projects/<id>/proposals.json`，应用前不会写盘

---

## 7. 扩展点

| 想做的事 | 改哪里 |
| --- | --- |
| 换模型 / 加温度策略 | `server/tsd/llm.py`，或在设置页配置 |
| 加一个流水线步骤 | `store.UPGRADE_STEPS` + `pipeline.run` 中插入一步（前端图标在 `PipelineTimeline` 的 `STEP_ICONS`） |
| 换差异渲染 | `src/components/diff/PatchView.tsx` |
| 新增主题 | `src/index.css` + `src/stores/app.ts` 的 `THEMES` |
| 用别的后端语言 | 实现 `docs/API.md`，前端零改动 |
| 加项目维度字段 | `shared/types.ts` → `server/tsd/store.py` → 页面按需展示 |
