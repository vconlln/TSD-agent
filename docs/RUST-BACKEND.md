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
| **L3 对话** | `POST /projects/:id/chat` + `chat.delta/reasoning/tool/message` | ⏳ | `run_chat_e2e` 的 25 项断言 |
| **L4 Git 与凭证** | `/api/git/*`、`/api/auth/w3/*`、`/api/models` | ⏳ | `run_git_e2e` 的 37 项断言 |
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
cargo test                       # 5 个单测：补丁计数、章节切分、重命名识别…
cargo run --release -- --port 8801 --workspace ../scripts/e2e/.tmp/demo-workspace
```

```bash
# 验收
node scripts/contract-check.mjs --api http://127.0.0.1:8801 --read-only
```

---

## 目录结构

```
rust-backend/
├── Cargo.toml
├── README.md          # 快速上手 + 本层覆盖范围
└── src/
    ├── main.rs        # CLI（--port/--host/--workspace，与 Electron supervisor 的调用方式一致）
    ├── routes.rs      # 8 个只读接口
    ├── state.rs       # 工作区路径、目录约定、路径沙箱 safe_join
    ├── store.rs       # 项目读取、walk（忽略规则与 Python 版一致）、二进制/语言识别
    ├── diff.rs        # similar 逐文件补丁 + markdown 章节差异 + 重命名识别
    └── tests.rs       # 5 个单测（CI 可跑）
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