#!/usr/bin/env python3
"""极简 OpenAI 兼容 mock，用于端到端验证「编辑器内 AI」与截图。

- 修改请求：把 <file> 区块里的代码加一行中文注释后整体返回（JSON 里的 replacement）
- 解释请求：返回一段固定的 Markdown 说明

用法：python scripts/e2e/mock_llm.py --port 8799
"""
from __future__ import annotations

import argparse
import json
import re
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Mock LLM")


def _extract(tag: str, text: str) -> str:
    match = re.search(rf"<{tag}>\n?([\s\S]*?)\n?</{tag}>", text or "")
    return match.group(1) if match else ""


def _with_comment(code: str) -> str:
    stripped = code.lstrip("\n")
    return "// [AI] 已按需求补充说明（mock 模型，仅用于验证流程）\n" + stripped


@app.post("/v1/chat/completions")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    messages = body.get("messages") or []
    system = str(messages[0].get("content") or "") if messages else ""
    user = str(messages[-1].get("content") or "") if messages else ""

    if "replacement" in system or "精确修改" in system:
        file_block = _extract("file", user)
        selection = _extract("selection", user)
        replacement = _with_comment(selection if selection else file_block)
        content = json.dumps(
            {
                "summary": "为选中代码补充说明注释",
                "rationale": "mock 模型：验证修改 → 审阅 → 写入的完整链路",
                "replacement": replacement,
            },
            ensure_ascii=False,
        )
    else:
        content = (
            "**结论**：这段代码负责对外暴露问候函数。\n\n"
            "- 入口清晰，只有一个导出函数\n"
            "- 建议补充参数校验与单元测试\n"
            "- 若要支持多语言，可把文案抽到常量表"
        )

    payload = {
        "id": "chatcmpl-" + uuid.uuid4().hex[:12],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model") or "mock-edit",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 120, "completion_tokens": 60, "total_tokens": 180},
    }
    return JSONResponse(payload)


@app.get("/v1/models")
async def models() -> dict:
    return {"data": [{"id": "mock-edit", "object": "model"}]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
