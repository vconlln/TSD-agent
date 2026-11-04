"""TSD Agent — 参考后端（FastAPI）。

前端只依赖 docs/API.md 中的 HTTP 契约，本包是一个完整可用的实现：
- 解析方案页面为 Markdown
- 下载 / 克隆 / 复制代码
- 调用 OpenAI 兼容 LLM 生成 UPDATE.md 与代码改动
- 输出可审阅的统一差异
"""

__version__ = "1.2.0"
