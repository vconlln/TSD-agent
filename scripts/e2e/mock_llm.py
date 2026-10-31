#!/usr/bin/env python3
"""极简 OpenAI 兼容 mock：同时支持工具调用、行内修改与解释，用于端到端验证与截图。

- 请求里带 tools 时：按"读文件 → 改文件 → 跑测试 → 结束"的脚本返回 tool_calls
- 不带 tools 时：沿用行内修改/解释的应答

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


def _completion(content: str | None, tool_calls: list[dict] | None = None, model: str = "mock-edit") -> dict:
    message: dict = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:12],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 60, "total_tokens": 180},
    }


def _tc(name: str, args: dict) -> dict:
    return {
        "id": "call_" + uuid.uuid4().hex[:10],
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def _first_code_line(observation: str) -> str:
    for raw in observation.splitlines():
        if "|" not in raw:
            continue
        content = raw.split("|", 1)[1]
        if content.startswith(" "):
            content = content[1:]  # 去掉行号后的对齐空格，保留真实缩进
        if content.strip() and not content.lstrip().startswith("//"):
            return content.rstrip()
    return ""


def _scripted_agent(messages: list[dict]) -> dict:
    tool_messages = [m for m in messages if m.get("role") == "tool"]
    step = len(tool_messages)
    last_observation = str(tool_messages[-1].get("content") or "") if tool_messages else ""

    if step == 0:
        return _completion(
            "先读一下入口文件，确认现有实现。",
            [_tc("read_file", {"path": "src/index.ts"})],
        )
    if step == 1:
        line = _first_code_line(last_observation)
        if not line:
            return _completion("没读到内容，直接结束。", [_tc("finish", {"summary": "未读取到文件"})])
        return _completion(
            "在入口文件顶部补充升级说明注释。",
            [
                _tc(
                    "edit_file",
                    {
                        "path": "src/index.ts",
                        "old_string": line,
                        "new_string": "// [AI] v1.3.0 升级：补充说明\n" + line,
                    },
                )
            ],
        )
    if step == 2:
        return _completion("改动完成，跑一次测试确认没破坏构建。", [_tc("run_tests", {})])
    return _completion(
        "完成。",
        [
            _tc(
                "finish",
                {
                    "summary": "已在 src/index.ts 顶部补充升级说明注释，并运行了项目测试。",
                    "changed_files": ["src/index.ts"],
                },
            )
        ],
    )


def _scripted_json_agent(messages: list[dict]) -> dict:
    tool_turns = sum(1 for m in messages if m.get("role") == "assistant")
    if tool_turns == 0:
        return _completion(json.dumps({"thought": "先读文件", "tool": "read_file", "args": {"path": "src/index.ts"}}, ensure_ascii=False))
    if tool_turns == 1:
        return _completion(
            json.dumps(
                {
                    "thought": "补充注释",
                    "tool": "write_file",
                    "args": {"path": "src/index.ts", "content": "// [AI] JSON 协议写入\nexport const ok = true\n"},
                },
                ensure_ascii=False,
            )
        )
    return _completion(json.dumps({"thought": "完成", "final": "已通过 JSON 协议完成修改", "changed_files": ["src/index.ts"]}, ensure_ascii=False))


@app.post("/v1/chat/completions")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    messages = body.get("messages") or []
    tools = body.get("tools") or []
    system = str(messages[0].get("content") or "") if messages else ""
    user = str(messages[-1].get("content") or "") if messages else ""

    if tools:
        return JSONResponse(_scripted_agent(messages))
    if "只输出一个 JSON 对象" in system:
        return JSONResponse(_scripted_json_agent(messages))
    if '"edits"' in user and "## 用户消息" in user:
        # 对话补丁链路：返回 reply + 一个完整文件改动，前端会渲染成「代码修改建议」卡片
        # 用「## 用户消息」做唯一标识：流水线的代码改动提示用的是同一套 JSON schema
        todo = (
            "# 升级待办（mock）\n\n"
            "- [ ] 迁移脚本补充 dry-run 开关\n"
            "- [ ] 上线前在预发环境验证刷新令牌流程\n"
            "- [ ] 部署文档补充回滚步骤\n"
        )
        content = json.dumps(
            {
                "reply": "已把本次升级的待办事项整理成清单，并写入 \x60docs/UPGRADE_TODO.md\x60，可直接应用后提交。",
                "summary": "补充升级待办清单",
                "rationale": "mock 模型：验证「对话 → 补丁建议 → 应用」的完整链路",
                "edits": [
                    {"path": "docs/UPGRADE_TODO.md", "content": todo, "reason": "把待办固化成文档"}
                ],
            },
            ensure_ascii=False,
        )
        return JSONResponse(_completion(content))
    if '"edits"' in user:
        # 流水线的「代码改动」提示：返回一个真实可落盘的文件
        content = json.dumps(
            {
                "summary": "mock 模型：补充升级说明文档",
                "rationale": "把升级要点固化成文档，便于审阅差异",
                "edits": [
                    {
                        "path": "docs/UPGRADE_GUIDE.md",
                        "content": (
                            "# 升级指南（mock）\n\n"
                            "## 变更要点\n"
                            "- 升级说明集中记录在这里\n"
                            "- 刷新令牌流程需要预发环境验证\n"
                        ),
                        "reason": "沉淀升级说明",
                    }
                ],
            },
            ensure_ascii=False,
        )
        return JSONResponse(_completion(content))
    if "架构师" in system or "升级方案" in system:
        plan = (
            "# 升级方案（mock）\n\n"
            "## 一、升级目标\n- 补充升级说明\n- 保持接口兼容\n\n"
            "## 二、升级内容\n- 在入口文件顶部补充升级注释\n"
        )
        return JSONResponse(_completion(plan))
    if "replacement" in system or "精确修改" in system:
        file_block = _extract("file", user)
        selection = _extract("selection", user)
        content = json.dumps(
            {
                "summary": "为选中代码补充说明注释",
                "rationale": "mock 模型：验证修改 → 审阅 → 写入的完整链路",
                "replacement": _with_comment(selection if selection else file_block),
            },
            ensure_ascii=False,
        )
        return JSONResponse(_completion(content))
    text = (
        "**结论**：这段代码负责对外暴露问候函数。\n\n"
        "- 入口清晰，只有一个导出函数\n"
        "- 建议补充参数校验与单元测试\n"
        "- 若要支持多语言，可把文案抽到常量表"
    )
    return JSONResponse(_completion(text))


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
