# 端到端自测

两个脚本，都**不需要 API Key**（后端自动进入离线启发式模式），可直接在 CI 里跑。

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

## 验证真实模型

```bash
export TSD_LLM_API_KEY=sk-...
export TSD_LLM_BASE_URL=https://api.deepseek.com/v1
export TSD_LLM_MODEL=deepseek-chat
python scripts/e2e/run_git_e2e.py
```
