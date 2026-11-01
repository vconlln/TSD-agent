from __future__ import annotations

"""流式对话 Agent：把「DeepSeek 式」的多轮工具对话搬进项目聊天。

一次用户发言可能会经历多轮：
    LLM（流式，边想边说）→ 调用只读工具（看代码）→ 调用 propose_edit（给出改动）
    → 继续下一轮 → 最终一段自然语言回答。

与流水线里的 CodeAgent 的区别：
- 只读工具 + 「提案」工具，绝不直接写盘（改动要用户点「应用到代码」才落盘）；
- 全程流式：思考过程走 chat.reasoning，回答走 chat.delta，工具调用走 chat.tool；
- 轮数很少（默认 6），单轮超时更短，交互优先而不是自治优先。
"""

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .llm import LLMClient, LLMError
from .toolbox import Toolbox

MAX_ROUNDS = 6
OBSERVATION_LIMIT = 4000
MAX_EDITS = 8

SYSTEM_CHAT_AGENT = (
    "你是 TSD Agent 的项目升级助手，正在和工程师对话。你熟悉这个项目的原始方案、升级方案与升级后的代码库。"
    "\n\n工作方式（像资深工程师那样干活）：\n"
    "1. 先判断要不要看代码：涉及具体实现时，用 read_file / grep / list_files 主动核实，不要凭印象作答；\n"
    "2. 需要改代码时，用 propose_edit 提交「完整文件内容」，可以一次提多个文件；用户会在界面上审阅后决定是否应用；\n"
    "3. 回答用简体中文，结构清晰但不啰嗦；代码、路径、命令保持原样；\n"
    "4. 不要编造文件内容或测试结果；没看到就说不确定并说明需要看哪个文件；\n"
    "5. 不需要改代码时（纯提问），直接回答，不要调用 propose_edit。"
)

TOOL_SPECS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "列出项目中的文件（按目录），用来了解结构。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对项目根的目录，默认根目录"},
                    "depth": {"type": "integer", "description": "递归深度，1-4，默认 2"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取文件内容（带行号）。修改前必须先读。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对路径"},
                    "offset": {"type": "integer", "description": "起始行，默认 1"},
                    "limit": {"type": "integer", "description": "最多行数，默认 400"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "按正则搜索代码，返回 文件:行号:内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "正则表达式"},
                    "include": {"type": "string", "description": "文件过滤，例如 *.ts"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_edit",
            "description": "提交一个文件的完整最终内容作为修改建议（用户审阅后才会落盘）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对路径，新文件也可以"},
                    "content": {"type": "string", "description": "完整文件内容，不要省略"},
                    "reason": {"type": "string", "description": "为什么这样改，一句话"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "更新任务清单（可选，多步任务时用），会显示在对话里。",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "done"]},
                            },
                            "required": ["title", "status"],
                        },
                    }
                },
                "required": ["steps"],
            },
        },
    },
]


@dataclass
class ChatTurn:
    reply: str = ""
    reasoning: str = ""
    edits: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: int = 0
    rounds: int = 0
    protocol: str = "stream-tools"
    notes: list[str] = field(default_factory=list)


MakeEdit = Callable[[str, str, str], Awaitable[dict[str, Any] | None]]


class StreamingChatAgent:
    """一次用户发言 → 多轮工具对话 → 回复 + 改动建议。"""

    def __init__(
        self,
        llm: LLMClient,
        channel: Any,
        target_dir: Path,
        *,
        make_edit: MakeEdit,
        max_rounds: int = MAX_ROUNDS,
    ) -> None:
        self.llm = llm
        self.channel = channel
        self.toolbox = Toolbox(target_dir, allow_commands=False, max_output=OBSERVATION_LIMIT)
        self.make_edit = make_edit
        self.max_rounds = max(1, min(max_rounds, 10))
        self.turn = ChatTurn()

    # ------------------------------------------------------------------
    def emit(self, kind: str, data: dict[str, Any], message: str | None = None) -> None:
        try:
            self.channel.emit(kind, data=data, message=message)
        except Exception:
            pass

    def log(self, message: str, level: str = "info") -> None:
        try:
            self.channel.log(message, level, step="reason")
        except Exception:
            pass

    # ------------------------------------------------------------------
    async def run(self, messages: list[dict[str, Any]]) -> ChatTurn:
        tools = TOOL_SPECS
        for round_index in range(self.max_rounds):
            self.turn.rounds = round_index + 1
            try:
                data = await self._stream_round(messages, tools)
            except LLMError as exc:
                text = str(exc)
                if text == "stream-unsupported":
                    raise
                if "tools" in text.lower() and tools:
                    self.log("模型不接受 tools，改用纯文本对话", "warn")
                    self.turn.protocol = "stream-plain"
                    tools = []
                    data = await self._stream_round(messages, tools)
                else:
                    raise

            calls = data.get("calls") or []
            if not calls:
                break

            assistant_content = data.get("content") or ""
            messages.append(
                {
                    "role": "assistant",
                    "content": assistant_content,
                    "tool_calls": [
                        {
                            "id": call["id"],
                            "type": "function",
                            "function": {
                                "name": call["name"],
                                "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                            },
                        }
                        for call in calls
                    ],
                }
            )
            for call in calls:
                observation = await self._run_tool(call)
                messages.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": observation}
                )

        return self.turn

    # ------------------------------------------------------------------
    async def _stream_round(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        content_parts: list[str] = []
        calls: list[dict[str, Any]] = []
        reasoning_parts: list[str] = []
        async for chunk in self.llm.chat_stream(messages, tools=tools or None):
            kind = chunk.get("type")
            if kind == "reasoning":
                text = chunk.get("text") or ""
                if text:
                    reasoning_parts.append(text)
                    self.turn.reasoning += text
                    self.emit("chat.reasoning", {"delta": text})
            elif kind == "content":
                text = chunk.get("text") or ""
                if text:
                    content_parts.append(text)
                    self.turn.reply += text
                    self.emit("chat.delta", {"delta": text})
            elif kind == "tool_calls":
                calls = chunk.get("calls") or []
        return {"content": "".join(content_parts), "calls": calls}

    # ------------------------------------------------------------------
    async def _run_tool(self, call: dict[str, Any]) -> str:
        name = str(call.get("name") or "")
        args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        started = time.time()
        self.turn.tool_calls += 1

        try:
            if name == "propose_edit":
                path = str(args.get("path") or "").strip()
                body = args.get("content")
                reason = str(args.get("reason") or "").strip()
                if not path or not isinstance(body, str):
                    raise ValueError("propose_edit 需要 path 与 content")
                if len(self.turn.edits) >= MAX_EDITS:
                    raise ValueError(f"一次最多提 {MAX_EDITS} 个文件")
                edit = await self.make_edit(path, body, reason)
                if edit is None:
                    raise ValueError(f"路径不可写：{path}")
                self.turn.edits.append(edit)
                result = {
                    "ok": True,
                    "content": f"已记录改动建议：{path}（+{edit.get('additions', 0)} / -{edit.get('deletions', 0)}）",
                    "preview": path,
                }
            elif name == "update_plan":
                steps = args.get("steps") or []
                clean = [
                    {"title": str(item.get("title") or "")[:120], "status": str(item.get("status") or "pending")}
                    for item in steps
                    if isinstance(item, dict) and item.get("title")
                ][:12]
                self.emit("chat.plan", {"steps": clean})
                result = {"ok": True, "content": f"已更新任务清单（{len(clean)} 步）", "preview": "计划"}
            elif name in ("list_files", "read_file", "grep"):
                tool_result = await self.toolbox.call(name, args)
                result = {
                    "ok": tool_result.ok,
                    "content": tool_result.content[:OBSERVATION_LIMIT],
                    "preview": tool_result.content.replace("\n", " ")[:80],
                }
            else:
                result = {"ok": False, "content": f"未知工具：{name}", "preview": name}
        except Exception as exc:  # noqa: BLE001 - 工具错误回灌给模型
            result = {"ok": False, "content": f"工具执行失败：{exc}", "preview": str(exc)[:80]}

        duration = int((time.time() - started) * 1000)
        self.emit(
            "chat.tool",
            {
                "id": call.get("id") or f"chat_{self.turn.tool_calls}",
                "tool": name,
                "args": args,
                "ok": bool(result["ok"]),
                "durationMs": duration,
                "observation": str(result["content"])[:OBSERVATION_LIMIT],
                "preview": str(result.get("preview") or ""),
            },
            message=f"{name} {'✓' if result['ok'] else '✗'} {result.get('preview') or ''}",
        )
        self.log(f"对话工具 {name} {'成功' if result['ok'] else '失败'} · {str(result.get('preview') or '')[:120]}",
                 "info" if result["ok"] else "warn")
        return str(result["content"])


def build_chat_messages(system: str, history: list[dict[str, str]], context: str) -> list[dict[str, Any]]:
    """把项目上下文塞进第一条 user 消息，历史按原样接在后面。"""
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    if context.strip():
        messages.append({"role": "user", "content": context.strip()})
        messages.append({"role": "assistant", "content": "收到，我已经了解项目当前状态。"})
    for item in history:
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content})
    return messages
