#!/usr/bin/env python3
"""极简 OpenAI 兼容 mock：支持工具调用、流式（含 reasoning_content）、行内修改与解释。

- 带 tools + stream：模拟「思考 → 调工具 → 再思考 → 给答案」的对话 Agent
- 带 tools 非流式：按「读文件 → 改文件 → 跑测试 → 结束」的脚本返回 tool_calls
- 不带 tools：沿用行内修改 / 解释 / 方案生成的应答

用法：python scripts/e2e/mock_llm.py --port 8799
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

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


# ----------------------------------------------------------------------
# 流式（SSE）mock：模拟带 reasoning 的对话 Agent
# ----------------------------------------------------------------------
CHAT_ANSWER = """### 结论

我把这次改动拆成两件事，已经在下方给出可应用的补丁：

1. **补默认值**：`createOrder` 的 `amount` 增加校验，避免负数金额进库；
2. **补文档**：把待办与回滚步骤写进 `docs/CHAT_NOTES.md`，方便下次升级对照。

```ts
export function createOrder(id: string, amount: number): Order {
  if (amount <= 0) throw new Error('amount must be positive')
  return { id, amount, status: 'pending' }
}
```

需要我把同样的校验也加到 `refundOrder` 里吗？"""

CHAT_NOTES = """# 对话改动记录（mock）

- [x] 金额校验补到 createOrder
- [ ] 回滚步骤补充到部署文档
- [ ] 预发环境验证刷新令牌
"""


def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def _delta(payload: dict) -> dict:
    return {
        "id": "chatcmpl-mock-" + uuid.uuid4().hex[:8],
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "mock-edit",
        "choices": [{"index": 0, "delta": payload, "finish_reason": None}],
    }


def _tool_delta(call_id: str, name: str, args: dict, index: int = 0) -> dict:
    return _delta(
        {
            "tool_calls": [
                {
                    "index": index,
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
                }
            ]
        }
    )


async def _stream_chat(messages: list[dict], tools: list[dict]):
    system = str(messages[0].get("content") or "") if messages else ""
    tool_turns = sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls"))
    is_chat_agent = "项目升级助手" in system and bool(tools)

    def emit(payload: dict):
        return _sse(payload)

    if is_chat_agent:
        if tool_turns == 0:
            for text in ("先看看项目里都有什么文件，", "再决定要不要读具体实现。"):
                yield emit(_delta({"reasoning_content": text}))
                await asyncio.sleep(0.02)
                yield emit(_delta({"content": ""}))
            yield emit(_tool_delta("chat_list", "list_files", {"path": ".", "depth": 2}))
            yield emit({**_delta({}), "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
            yield "data: [DONE]\n\n"
            return
        if tool_turns == 1:
            for text in ("清单拿到了，", "把结论写成文档，", "顺便给 createOrder 补个校验。"):
                yield emit(_delta({"reasoning_content": text}))
                await asyncio.sleep(0.02)
            yield emit(
                _tool_delta(
                    "chat_edit",
                    "propose_edit",
                    {
                        "path": "docs/CHAT_NOTES.md",
                        "content": CHAT_NOTES,
                        "reason": "把这次对话的待办固化下来",
                    },
                    index=0,
                )
            )
            yield emit(_tool_delta(
                "chat_edit2",
                "propose_edit",
                {
                    "path": "docs/CHAT_PLAN.md",
                    "content": "# 后续计划（mock）\n\n1. 回滚步骤补进部署文档\n2. 预发验证刷新令牌\n",
                    "reason": "列出后续动作",
                },
                index=1,
            ))
            yield emit({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
            yield "data: [DONE]\n\n"
            return
        for chunk in re.findall(r"[\s\S]{1,6}", CHAT_ANSWER):
            yield emit(_delta({"content": chunk}))
            await asyncio.sleep(0.008)
        yield emit({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 320, "completion_tokens": 180}})
        yield "data: [DONE]\n\n"
        return

    # 其它场景（方案生成 / 解释）：先给一段思考，再给正文
    body = "# 升级方案（mock）\n\n## 一、升级目标\n- 补充升级说明\n- 保持接口兼容\n"
    for text in ("先读需求，", "再落到步骤上。"):
        yield emit(_delta({"reasoning_content": text}))
        await asyncio.sleep(0.02)
    for chunk in re.findall(r"[\s\S]{1,8}", body):
        yield emit(_delta({"content": chunk}))
        await asyncio.sleep(0.01)
    yield emit({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    yield "data: [DONE]\n\n"



@app.post("/v1/chat/completions")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    messages = body.get("messages") or []
    tools = body.get("tools") or []
    system = str(messages[0].get("content") or "") if messages else ""
    user = str(messages[-1].get("content") or "") if messages else ""

    if body.get("stream"):
        return StreamingResponse(_stream_chat(messages, tools), media_type="text/event-stream")
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