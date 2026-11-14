# tsd-server-rs

TSD Agent 的 **Rust 后端**（按契约分层迁移，已完成第 1~3 层）。

前端一行都不用改：它只认 `docs/BACKEND-INTEGRATION.md` 里的 HTTP + SSE 契约。

## 当前覆盖（全 5 层）

| 接口 | 状态 |
| --- | --- |
| `GET /api/health` | ✅ |
| `GET /api/settings` | ✅（读 `<workspace>/.tsd/config.json`，只回 `apiKeySet`） |
| `GET /api/projects` | ✅ |
| `GET /api/projects/:id` | ✅ |
| `GET /api/projects/:id/documents` | ✅ |
| `GET /api/projects/:id/diff` | ✅（逐文件 unified patch + 方案章节差异） |
| `GET /api/projects/:id/tree` | ✅ |
| `GET /api/projects/:id/file` | ✅（二进制识别、超大文件截断） |
| `POST/PATCH/DELETE /api/projects` | ✅ |
| `POST /api/projects/:id/run` | ✅（7 步离线流水线，无模型） |
| `GET /api/runs`、`GET /api/runs/:id`、`POST /api/runs/:id/cancel` | ✅ |
| `GET /api/runs/:id/events`（SSE） | ✅（seq 按 run 隔离、since 回放、`[DONE]`、重启后从 jsonl 回放） |
| `PUT /api/settings` | ✅（白名单合并、密钥只写不回传、原子落盘） |
| `POST /api/projects/:id/chat` | ✅（流式：`chat.reasoning/delta/tool/message`；5 个工具；最多 6 轮） |
| `POST/DELETE /api/projects/:id/apply` | ✅（提案落盘 + 立刻重算 diff） |
| `GET /api/auth/w3/status`、`POST /api/auth/w3/login`、`POST /api/auth/w3/logout` | ✅（演示模式 / 真实网关两种口径，密码不落盘） |
| `GET /api/models` | ✅（未登录 401；登录后回内置或网关模型清单） |
| `GET /api/git/repos` | ✅（本地扫描识别裸仓库；GitLab / GitHub / 通用 REST，失败回退本地） |
| `/api/projects/:id/git/{clone,status,branches,compare,publish,push}` | ✅（保留 `.git`、只同步差异文件、令牌注入 https 推送） |
| `/api/projects/:id/{files/write,search,export}` | ✅（写入即刷新差异；导出 zip 含 plan + diff + code） |
| `/api/projects/:id/agent/{edit,explain}` | ✅（无模型时解释走结构化静态分析、修改明确拒绝） |
| Agent 多步工具循环（流水线 `code` 步骤） | ✅（两种协议：function calling / JSON 降级；工具沙箱；验证重试；步数与时长预算） |

## 运行

```bash
# 1) 准备一个工作区（可以直接用 Python 参照实现生成的演示工作区）
cd .. && npm run seed:demo -- --workspace rust-backend/.demo
# 2) 编译并启动
cd rust-backend
cargo run --release -- --port 8801 --workspace .demo
# 3) 默认走 127.0.0.1:8801，路径与 Python 版一致
```

国内网络（crates.io 直连被挡）时用工作区内的 CARGO_HOME：

```bash
export CARGO_HOME=$(pwd)/../.cargo   # 已内置 rsproxy 稀疏索引配置
cargo build --release
```

## 验证

```bash
# 只读模式：不创建项目、不触发运行
node ../scripts/contract-check.mjs --api http://127.0.0.1:8801 --read-only   # L1：只读 13/13
node ../scripts/contract-check.mjs --api http://127.0.0.1:8801 --no-chat      # L2：+ 运行与 SSE 27/27
node ../scripts/contract-check.mjs --api http://127.0.0.1:8801                # L3：+ 对话与提案 30/30
```

深度验证（同一套断言跑 Python 版和 Rust 版，证明契约等价）：

```bash
python ../scripts/e2e/run_chat_e2e.py                 # Python 参照后端
python ../scripts/e2e/run_chat_e2e.py --backend rust  # Rust 后端，25 项断言
python ../scripts/e2e/run_git_e2e.py --backend rust   # Git + W3 + 编辑器 AI，37 项断言
python ../scripts/e2e/run_agent_e2e.py --backend rust  # Agent 工具循环 + 沙箱，23 项断言
```

## 提示词外置（热重载）

`prompts/` 下的 markdown 是运行时读取的，**改完保存即生效，不需要重新编译**：

| 文件 | 用途 |
| --- | --- |
| `prompts/agent.md` | 流水线 `code` 步骤的 Agent 系统提示词 |
| `prompts/chat.md` | 对话 Agent 系统提示词 |
| `prompts/inline-edit.md` / `prompts/inline-explain.md` | 编辑器内 AI 修改 / 解释 |
| `prompts/coder.md` | 一次性生成代码改动（Agent 不可用时的兜底） |

查找顺序：`TSD_PROMPTS_DIR` → `<可执行文件同级>/prompts` → 源码树 `rust-backend/prompts`；
都找不到时回落到内置默认（编译进二进制，作为最后一道保险）。

## 设计取舍

- **不依赖 git**：差异计算用 `similar` crate 逐文件做，未改动文件只比大小+内容哈希。
  （参照实现的 Python 版用 difflib；真机若想更快可后续换成 `git diff --no-index` 子进程。）
- **项目数据原样透传**：`project.json` 直接序列化给前端，字段契约由写入方决定，
  Rust 侧不重新建模，避免两边字段漂移。
- **对话只提案、不写盘**：`chat` 路径没有任何写权限，改动只能经 `propose_edit` 变成提案，
  由用户点「应用到代码」触发 `POST /apply` 才落盘。这样「模型说错了」永远不需要回滚。
- **路径沙箱读写分开**：读用 `safe_join`（目标必须已存在），写用 `safe_write_path`（允许新建，
  逐级建目录后校验父目录仍在沙箱内）。混用会让「新建文档」这类提案被静默跳过。