# 端到端自测

三个脚本，都**不需要 API Key**，可直接在 CI 里跑（合计 93 项断言）：

| 脚本 | 断言 | 需要模型？ | 说明 |
| --- | --- | --- | --- |
| `run_e2e.py` | 33 | 否（离线启发式） | 升级流水线全链路 |
| `run_git_e2e.py` | 37 | 否（离线降级） | 凭证 / Git / 编辑器 AI |
| `run_agent_e2e.py` | 23 | 脚本化假模型 | 编码 Agent 循环 |

`npm run e2e:all` 一次跑完三个。

## 1. 升级流水线 `run_e2e.py`

方案页面 → 代码压缩包 → 升级方案 → 代码升级 → 差异 / 目录树 / 文件 → 对话补丁 → 导出。

```bash
python scripts/e2e/run_e2e.py
python scripts/e2e/run_e2e.py --keep     # 保留临时工作区，便于用 GUI 打开检查
```

## 2. 凭证 / Git / 编辑器 AI `run_git_e2e.py`

在临时工作区里造一个裸仓库，覆盖：

- W3 演示登录 → 凭证 → 模型清单 → 退出
- 按前缀检索仓库（`micabc.git`）
- 克隆 → 升级（复用已有克隆，不重复下载）
- 本地 vs 远程对比（ahead / behind / 文件清单）
- 新建分支 + 提交 + 推送，并校验裸仓库确实收到了分支
- 编辑器 AI：解释（离线结构化分析）、修改（未配置模型时明确拒绝）
- 文件写回接口 + 差异刷新 + 非法路径拦截

```bash
python scripts/e2e/run_git_e2e.py
```

> 需要本机安装 `git`。脚本会把仓库建在 `scripts/e2e/.tmp/` 下，成功后自动清理。

## 3. 编码 Agent `run_agent_e2e.py`

用 `mock_llm.py` 起一个**脚本化的假模型**（严格按 `read_file → edit_file → run_tests → finish` 行动），
因此不需要真实模型就能验证 Agent 循环本身：

- 工具协议：`read_file` / `edit_file` / `run_tests` 确实被调用，验证通过并记录 `agent.verify`
- `code` 步骤带 `{"工具调用": n, "改动文件": m}` 指标
- 步骤状态已持久化到 `runs/<id>.json`（刷新页面进度不回零）
- JSON 协议降级：模型不支持 function calling 时依然能改文件
- 沙箱：`../` 越界、`sudo rm -rf`、白名单外命令、关闭命令执行时全部被拦截
- `edit_file` 的 `old_string` 不匹配时给出可操作的纠偏提示

```bash
python scripts/e2e/run_agent_e2e.py
```

## 验证真实模型

```bash
export TSD_LLM_API_KEY=sk-...
export TSD_LLM_BASE_URL=https://api.deepseek.com/v1
export TSD_LLM_MODEL=deepseek-chat
python scripts/e2e/run_git_e2e.py
```

> `run_agent_e2e.py` 默认用假模型；接真实模型时把设置里的 `engine` 指向真实接口，
> 并观察「Agent」标签页的时间线是否推进（工具调用是否真的发生、验证是否真的在跑）。
