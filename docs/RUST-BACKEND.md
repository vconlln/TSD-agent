# Rust 后端迁移计划（B 路线）

> 前端一行都不用改：它只认 `docs/BACKEND-INTEGRATION.md` 里的 HTTP + SSE 契约。
> 本文件记录**分层迁移的顺序、每层的验收口径、已完成状态与实测数据**。

---

## 为什么是这个顺序

Agent 类后端有两类代码：

| 类型 | 例子 | 变更频率 | 迁移风险 |
| --- | --- | --- | --- |
| **稳定的契约层** | health / projects / documents / diff / tree / file | 几乎不变 | 低：形状固定，可用 `contract-check` 卡死 |
| **高频变化的编排层** | agent 循环、提示词、工具集、模型协议适配 | 每周都在改 | 高：改一次就要重新验证模型行为 |

所以顺序是「**先搬稳定的、后搬多变的**」：先把只读契约搬过去并让检查器全绿，
再搬运行/事件流，最后才是 agent 循环。这样任何一层出问题都能独立回滚。

---

## 分层清单

| 层 | 内容 | 状态 | 验收 |
| --- | --- | --- | --- |
| **L1 只读契约** | `GET /api/health`、`/settings`、`/projects`、`/projects/:id`、`/documents`、`/diff`、`/tree`、`/file` | ✅ **已完成** | `contract-check --read-only` 13/13 |
| **L2 运行与事件流** | `POST/PATCH/DELETE /projects`、`POST /projects/:id/run`、`GET /runs`、`GET /runs/:id`、`POST /runs/:id/cancel`、`GET /runs/:id/events`（SSE） | ✅ **已完成** | `contract-check --no-chat` 必需项 **27/27** |
| **L3 对话与提案** | `POST /projects/:id/chat` + `chat.delta/reasoning/tool/message` + `POST/DELETE /projects/:id/apply` + `GET/PUT /settings` | ✅ **已完成** | `contract-check` 必需项 **30/30**；`run_chat_e2e --backend rust` **25/25** |
| **L4 Git 与凭证** | `/api/git/*`、`/api/auth/w3/*`、`/api/models`、`files/write`、`search`、`export`、`agent/edit｜explain` | ✅ **已完成** | `run_git_e2e --backend rust` **37/37** |
| **L5 Agent 循环** | 工具沙箱、验证循环、提示词、模型协议 | ⏳ | `run_agent_e2e` 的 23 项断言 |

---

## L1 实测数据（2026-11，本机 Linux，同一份工作区）

### 启动与内存

| 指标 | Rust | Python（参照实现） |
| --- | --- | --- |
| 冷启动到 `/api/health` 可用 | **9 ms** | 551 ms |
| 常驻内存 RSS | **4.5 MB** | 59.4 MB |
| 产物体积 | **1.7 MB** 单文件 | 28 MB（PyInstaller onedir，含 python311.dll） |

### 差异计算（`GET /diff?refresh=1`，两侧各 800 文件、267 个改动）

| 实现 | 耗时 | 输出 |
| --- | --- | --- |
| **Rust（similar）** | **35–55 ms** | stats 一致：files 800 / added 2937 / removed 2937 / filesChanged 267 |
| Python（difflib，参照实现） | 147–188 ms | 同上 |
| `git diff --no-index -U3`（生产里常用的路子） | 72–89 ms | unified patch 同级 |

结论：Rust 约为 Python difflib 的 **3–4 倍**，也比 `git diff` 子进程约快 **1.5–2.5 倍**
（省掉进程启动与 IPC 开销，且大文件走内存）。

### 输出一致性

| 接口 | 结果 |
| --- | --- |
| `GET /api/projects` | 与 Python 响应**字节一致**（3425B） |
| `GET /api/projects/:id` | 字节一致（993B） |
| `GET /api/projects/:id/documents` | 字节一致（625B） |
| `GET /api/projects/:id/tree?side=target` | 字节一致（583B） |
| `GET /api/projects/:id/diff?refresh=1` | stats 与「文件→状态→增删行」集合完全一致；patch 文本因 hunk 切分策略不同，长度略有差异（语义相同） |
| `contract-check --read-only` | **必需项 13/13 通过**（Python 版同样 13/13，说明检查器本身没有偏袒） |

---

## 本地运行

```bash
# 依赖：Rust 1.8x（本机 1.98）；国内网络用工作区内 CARGO_HOME（已内置 rsproxy 源）
export CARGO_HOME=$(pwd)/../.cargo
cd rust-backend
cargo build --release
cargo test                       # 10 个单测：补丁计数、章节切分、重命名识别、seq、路径沙箱…
cargo run --release -- --port 8801 --workspace ../scripts/e2e/.tmp/demo-workspace
```

```bash
# 验收（逐层收紧；已封装成 npm script）
npm run rust:check:read    # L1：只读契约 13/13
npm run rust:check:l2      # L2：加上运行与 SSE，27/27
npm run rust:check         # L3：再加对话与提案，30/30
npm run rust:e2e:chat      # L3 深度：同一套 25 项断言跑 Rust 后端
npm run rust:e2e:git       # L4 深度：Git + W3 + 编辑器 AI，37 项断言
npm run rust:e2e:all       # 上面两个一起跑
```

---

## 目录结构

```
rust-backend/
├── Cargo.toml
├── README.md          # 快速上手 + 本层覆盖范围
└── src/
    ├── main.rs        # CLI（--port/--host/--workspace，与 Electron supervisor 的调用方式一致）
    ├── routes.rs      # 全部 HTTP 路由（只读 / 项目 / 运行 / SSE / 对话 / 应用提案 / 配置）
    ├── state.rs       # 工作区路径、目录约定、路径沙箱 safe_join（读）与 safe_write_path（写）
    ├── store.rs       # 项目读取、walk（忽略规则与 Python 版一致）、二进制/语言识别
    ├── diff.rs        # similar 逐文件补丁 + markdown 章节差异 + 重命名识别
    ├── events.rs      # 事件中心：按 run 的 seq、环形缓冲、广播、jsonl 落盘
    ├── runs.rs        # 运行记录与步骤（升级 7 步 / 对话 3 步）
    ├── projects.rs    # 项目 CRUD、slug、版本号
    ├── pipeline.rs    # 7 步升级流水线 + refresh_project_diff
    ├── settings.rs    # 工作区配置（白名单合并、密钥只写不回传、环境变量/内置默认）
    ├── llm.rs         # OpenAI 兼容客户端：SSE 解析、reasoning 分离、tools/stream 降级
    ├── chat.rs        # 对话 Agent：5 个工具、改动提案、离线兜底
    └── tests.rs       # 10 个单测（CI 可跑）
```

---

## L2 实测（2026-11）

| 项 | 结果 |
| --- | --- |
| `contract-check --no-chat` | **必需项 27/27**（含 SSE：24 个事件、seq 单调、7 个步骤 key、步骤写回 run.json） |
| 一次完整流水线 | 7 步全 done，产出 `plan/PLAN.md`、`plan/UPDATE.md`、`source/`、`v{target}/`（CHANGELOG / UPGRADE_NOTES / 版本号 / README）、`diff.json` |
| 冷启动 | 9 ms（Python 551 ms） |
| 单元测试 | **9 个**（补丁计数/空补丁/章节切分/章节增删改/重命名识别/seq 单调/since 回放/终止事件关闭通道/事件落盘） |

### L2 已实现的行为

- 事件中心：每 run 一条通道，seq 从 1 单调递增；内存环形缓冲 4000 条 + `runs/<id>.events.jsonl` 落盘
- SSE：`since=N` 先回放 `seq > N` 的历史再转实时；`run.done`/`run.error` 后发 `data: [DONE]` 并关闭；进程重启后从 jsonl 回放
- 步骤写回：每次 `step.status` 立即写 `runs/<id>.json`（前端刷新只读这个）
- 取消：`POST /runs/:id/cancel` 置原子标记，流水线在每个阶段边界检查
- 流水线：fetch（curl 抓页面 + HTML 转文本）/ download（本地目录复制、git clone、解压、兜底脚手架）/ analyze / update / code（确定性离线改动）/ diff / finalize

## L2 设计要点（已按此实现）

1. **事件中心**：`HashMap<runId, Channel>` + 环形缓冲（内存里保留最近 N 条），
   同时把每条事件 append 到 `runs/<runId>.events.jsonl` 用于**进程重启后回放**。
2. **SSE**：`axum::response::sse::Sse`，每帧 `data: {...}\n\n`，结束发 `data: [DONE]`；
   `since=N` 时先回放历史（seq > N）再转实时；`run.done`/`run.error` 后关闭。
3. **seq 按 run 隔离**：从 1 开始单调递增（这是前端续传的唯一依据）。
4. **取消**：`POST /runs/:id/cancel` 设置 `AtomicBool`，流水线在每个阶段边界检查。
5. **步骤写回**：每次 `step.status` 同步更新 `runs/<runId>.json` 的 steps（否则刷新后进度归零）。

## L5 设计要点（agent 循环，最需要提前定的）

- **提示词外置**：放在 `prompts/*.md`，运行时读取 + 文件监听热重载，
  **不要用 `include_str!` 编译进二进制**——否则改一句 prompt 就要重新编译。
- **工具注册表**：`tool_specs()` 生成 JSON Schema；工具实现各自一个模块，统一 async trait。
- **模型适配层单独 crate**：内网网关的怪癖（SSE 字段缺失、tools 不支持）集中隔离在一个文件。
- **配置外置**：步数预算、超时、观察截断长度放 `config.json`，不写死在代码里。
---

## L3 实测（2026-11）

| 项 | 结果 |
| --- | --- |
| `contract-check`（全量） | **必需项 30/30**；可选项剩 `/api/auth/w3/status`、`/api/models`（L4） |
| 对话事件 | `chat.reasoning` 5 段、`chat.delta` 60 块、`chat.tool` 3 次（list_files + 2×propose_edit）、`chat.message` 带 2 个文件的提案 |
| `run_chat_e2e --backend rust` | **25/25** 断言全绿：流式思考先于正文、工具全成功、提案落盘、差异刷新可见、多轮历史、离线降级 |
| 单元测试 | **10 个**（新增：`safe_write_path` 允许新建嵌套文件、拒绝 `..` 越界） |
| 冷启动 | 9 ms（引入 reqwest/rustls 后未变） |

### L3 已实现的行为

- **模型客户端**（`llm.rs`）：OpenAI 兼容 `/chat/completions`；SSE 逐帧解析，
  `reasoning_content` / `reasoning` / `thinking` 三种思考字段统一抽出、不混进正文；
  工具调用按 `index` 增量拼装（网关把参数分片发也能还原）。
- **两条降级路径**（实测均通过）：
  1. 服务端忽略 `stream` 直接返回整段 JSON → 检测到「没有任何 SSE 帧」即退回非流式 `chat_once`；
  2. 服务端对 `tools` 返回 400 → 去掉工具重试一次纯文本对话。
  两条路径都会把完整答案切片（36 字一块）推成 `chat.delta`，前端「逐字出现」的观感不变。
- **对话 Agent**（`chat.rs`）：5 个工具 —— `list_files` / `read_file` / `grep` / `propose_edit` / `update_plan`，最多 6 轮；
  **对话里没有写盘权限**，所有改动只变成提案（`propose_edit` → `proposals.json`），
  用户点「应用到代码」才由 `POST /apply` 落盘。这条权限切分是刻意的：对话路径不需要备份也能回滚。
- **提案与落盘**（`POST /apply`）：写入 `v{targetVersion}/`，随后立刻重算 `diff.json` 并回写项目 stats，
  前端不用等下一次流水线就能看到新差异；`DELETE /apply` 只标记 discarded。
- **配置**（`settings.rs`）：白名单合并（未知键忽略）、`apiKey` / `git.token` 只写不回传（对外只有 `apiKeySet` / `tokenSet`）、
  临时文件 + rename 原子落盘；优先级依次为 内置默认 → `TSD_DEFAULTS_FILE` → `config.json` → `TSD_LLM_*` 环境变量。
- **离线口径**：`offlineMode` 或 `provider=offline` 时 `/api/health` 报 `engine=offline`，
  对话走确定性兜底（把追加需求写进 `UPGRADE_NOTES.md` 作为提案），仍可应用。

### 踩坑记录：`safe_join` 只能读，不能写

`safe_join` 用 `canonicalize` 校验，**只适合读已有文件**：对话提案经常新建 `docs/xxx.md`，
canonicalize 失败会被静默跳过（接口返回 200 但 `files: []`）。现在读写分开：
读用 `safe_join`，写用 `safe_write_path`（逐级建目录后校验父目录仍在沙箱内）。


---

## L4 实测（2026-11）

| 项 | 结果 |
| --- | --- |
| `run_git_e2e --backend rust` | **37/37** 断言全绿 |
| W3 凭证 | 演示模式（无网关）签发本地凭证、拒绝短密码、`tokenPreview`、退出清理；真实网关走 reqwest 登录（`token`/`accessToken`/`access_token` 三种字段都兼容） |
| 模型清单 | `/api/models` 未登录 401（与 Python 同口径）；登录后演示模式回内置 4 个模型，`source=builtin`；真实网关按 `models`/`data`/`items` 三种返回解析 |
| 仓库检索 | 本地扫描识别工作区仓库与**裸仓库**（`HEAD`+`objects`+`refs`）；远程支持 GitLab / GitHub / 通用 REST，失败自动回退本地并给出说明 |
| 克隆 → 升级 → 提交 → 推送 | 克隆保留 `.git`；升级后 `publish` 建 `upgrade/v1.3.0` 分支、只同步差异文件、提交并推送到裸仓库；`compare` 显示 `ahead=1` |
| 编辑器内 AI | 无模型时解释退化为结构化静态分析（依赖/类型/函数/导出）、修改明确拒绝并给出可操作提示 |
| 文件写回 | `POST /files/write` 写入后立刻刷新差异；`../../escape.ts` 被 400 拒绝 |
| 导出 | `POST /export` 产出 `plan/*` + `diff.json` + `code/*` 的 zip（deflate） |

### L4 期间修掉的真实缺陷

流水线的 `download` 步骤原来**无条件删掉** `source/` 再重新拉取，会把克隆来的 `.git` 一起删掉，
导致后续「提交/推送」全部报「不是 Git 仓库」。现在与 Python 版一致：`sourceKind=git` 且 `source/.git` 存在时直接复用。
这个 bug 只有把 e2e 真的跑在 Rust 后端上才会暴露（契约检查器看不到 `.git`）。

### 为什么把编辑器内 AI 放在 L4

`agent/edit`、`agent/explain` 是「单轮、无工具、有明确降级」的调用，接上 `llm.rs` 就能跑通；
真正需要单独一层的是**多步工具循环**（L5）：步数预算、观察截断、验证命令、失败重试，那些才是易变部分。

