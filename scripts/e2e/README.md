# 端到端自测

验证完整链路：方案页面 → 代码压缩包 → 升级方案 → 代码升级 → 差异 / 目录树 / 文件 → 对话补丁 → 导出。

```bash
# 依赖（与后端一致）
pip install -r server/requirements.txt

# 运行
python scripts/e2e/run_e2e.py

# 保留临时工作区，便于用 GUI 打开检查
python scripts/e2e/run_e2e.py --keep
```

无需 API Key：后端会自动使用离线启发式模式。若想验证真实模型，设置环境变量：

```bash
export TSD_LLM_API_KEY=sk-...
export TSD_LLM_BASE_URL=https://api.deepseek.com/v1
export TSD_LLM_MODEL=deepseek-chat
python scripts/e2e/run_e2e.py
```
