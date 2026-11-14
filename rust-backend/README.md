# tsd-server-rs

TSD Agent 的 **Rust 后端**（按契约分层迁移，第 1 层：只读接口）。

前端一行都不用改：它只认 `docs/BACKEND-INTEGRATION.md` 里的 HTTP + SSE 契约。

## 当前覆盖（第 1 层）

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
| 其余（run / SSE / chat / git / W3） | ⏳ 第 2~4 层 |

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
node ../scripts/contract-check.mjs --api http://127.0.0.1:8801 --read-only
```

## 设计取舍

- **不依赖 git**：差异计算用 `similar` crate 逐文件做，未改动文件只比大小+内容哈希。
  （参照实现的 Python 版用 difflib；真机若想更快可后续换成 `git diff --no-index` 子进程。）
- **项目数据原样透传**：`project.json` 直接序列化给前端，字段契约由写入方决定，
  Rust 侧不重新建模，避免两边字段漂移。
- **写路径全部不存在**：第 1 层只读，没有 `POST/PATCH/DELETE`，因此可以安全地挂在生产旁边做对比。
