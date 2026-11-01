from __future__ import annotations

"""Agent 循环：让模型像工程师一样"读代码 → 改代码 → 跑验证 → 修问题"。

与一次性生成的差别：
- 模型每一步只能看到自己主动取回的上下文（工具读文件/搜索），不会被整仓代码淹没；
- 每次修改都能立刻回读确认，改错了下一轮还能看到错误并纠正；
- 改完必须跑测试/类型检查，失败会把输出回喂，最多重试若干轮；
- 全程有步数、时长与上下文预算，随时可取消，每一步都通过事件流可见。

协议有两种：
- tools：OpenAI 兼容的 function calling（首选）；
- json：模型不支持 tools 时的降级协议，只输出一个 JSON 对象。
"""

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .llm import LLMClient, LLMError
from .repo_map import build_repo_map, detect_commands, read_project_instructions
from .toolbox import ToolResult, Toolbox, tool_specs
from .utils import now_ms

MAX_PARSE_FAILURES = 3
MAX_VERIFY_ROUNDS = 2
CONTEXT_CHAR_BUDGET = 120_000

SYSTEM_AGENT = (
    "你是一名资深软件工程师，在真实代码库里完成升级改造任务。"
    "你可以调用工具读文件、搜索、修改文件、运行命令。"
    "铁律：\n"
    "1. 不要凭空猜测代码内容：修改前先用 read_file 或 grep 确认原文；\n"
    "2. 一次只做一小步，改完立刻回读或跑测试确认；\n"
    "3. edit_file 的 old_string 必须与文件内容逐字一致（含缩进）；\n"
    "4. 改完必须运行测试/类型检查（run_tests 或 run_command），失败要读错误并修复；\n"
    "5. 不要执行 git push/commit、不要改项目外的文件、不要安装全局依赖；\n"
    "6. 任务完成时调用 finish 工具，用中文总结改了什么、为什么、验证结果。"
)

JSON_PROTOCOL = (
    "\n\n可用工具：{tools}\n\n"
    "你必须**只输出一个 JSON 对象**，不要输出解释文字或代码围栏，格式二选一：\n"
    '1) 调用工具：{{"thought": "你的判断", "tool": "工具名", "args": {{...}}}}\n'
    '2) 结束任务：{{"thought": "…", "final": "改动总结与验证结论", "changed_files": ["…"]}}\n'
    "每次只调用一个工具；观察结果会以 user 消息返回给你。"
)


@dataclass
class AgentConfig:
    mode: str = "auto"
    max_steps: int = 24
    allow_commands: bool = True
    verify: bool = True
    deadline_seconds: int = 900
    max_observation_chars: int = 6000

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "AgentConfig":
        data = data or {}
        return cls(
            mode=str(data.get("mode") or "auto"),
            max_steps=max(2, min(int(data.get("maxSteps") or 24), 80)),
            allow_commands=bool(data.get("allowCommands", True)),
            verify=bool(data.get("verify", True)),
            deadline_seconds=max(60, min(int(data.get("deadlineSeconds") or 900), 7200)),
            max_observation_chars=max(1000, min(int(data.get("maxObservationChars") or 6000), 20000)),
        )


@dataclass
class AgentStats:
    steps: int = 0
    tool_calls: int = 0
    failed_calls: int = 0
    changed_files: list[str] = field(default_factory=list)
    verified: bool | None = None
    verify_rounds: int = 0
    protocol: str = ""
    notes: list[str] = field(default_factory=list)


class CodeAgent:
    """在给定目录内执行一次编码任务。"""

    def __init__(
        self,
        llm: LLMClient,
        *,
        channel: Any,
        config: AgentConfig,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.llm = llm
        self.channel = channel
        self.config = config
        self.is_cancelled = is_cancelled or (lambda: False)
        self.stats = AgentStats()
        self.deadline = 0.0
        self.protocol = "tools" if config.mode in ("auto", "tools") else "json"
        if config.mode == "json":
            self.stats.protocol = "json"

    # ------------------------------------------------------------------
    def emit(self, kind: str, data: dict[str, Any], message: str = "") -> None:
        payload = {"ts": now_ms(), **data}
        try:
            self.channel.emit(kind, data=payload, message=message or None)
        except Exception:
            pass

    def log(self, message: str, level: str = "info") -> None:
        try:
            self.channel.log(message, level, step="code")
        except Exception:
            pass

    # ------------------------------------------------------------------
    async def run(self, task: str, target_dir: Any, *, plan: str = "") -> dict[str, Any]:
        toolbox = Toolbox(
            target_dir,
            allow_commands=self.config.allow_commands,
            max_output=self.config.max_observation_chars,
        )
        repo_map = build_repo_map(target_dir)
        instructions = read_project_instructions(target_dir)
        self.deadline = time.time() + self.config.deadline_seconds

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_AGENT + self._protocol_suffix()},
            {
                "role": "user",
                "content": self._task_brief(task, repo_map, instructions, plan),
            },
        ]

        final_summary = ""
        parse_failures = 0

        while self.stats.steps < self.config.max_steps:
            if self._stopped():
                self.log("Agent 达到预算或被取消，提前收尾", "warn")
                break
            self.stats.steps += 1
            progress = min(95, int(self.stats.steps / self.config.max_steps * 100))
            try:
                self.channel.step_status(
                    "code",
                    status="running",
                    detail=f"Agent 第 {self.stats.steps} 步 · 已调用工具 {self.stats.tool_calls} 次",
                    progress=progress,
                )
            except Exception:
                pass

            try:
                decision = await self._decide(messages)
            except LLMError as exc:
                self.log(f"模型调用失败：{exc}", "error")
                raise
            if decision is None:
                parse_failures += 1
                if parse_failures > MAX_PARSE_FAILURES:
                    self.log("模型连续返回无法解析的内容，结束 Agent", "warn")
                    break
                messages.append(
                    {
                        "role": "user",
                        "content": "无法解析你的回复。请只输出一个 JSON 对象（tool/args 或 final）。",
                    }
                )
                continue

            if decision.get("final"):
                final_summary = str(decision["final"])
                self.emit("agent.thought", {"text": decision.get("thought") or ""})
                self.stats.notes.append(final_summary[:400])
                break

            thought = str(decision.get("thought") or "").strip()
            if thought:
                self.emit("agent.thought", {"text": thought})
                self.log(f"思考：{thought[:180]}", "debug")

            calls = decision.get("calls") or []
            if not calls:
                # 模型只回了文字：视为结束
                final_summary = str(decision.get("content") or "").strip()
                break

            for call in calls:
                result = await self._execute(call, toolbox)
                observation = self._format_observation(call["name"], result)
                self._append_observation(messages, call, observation, decision)
                if toolbox.finished:
                    final_summary = toolbox.summary
                    break
            if toolbox.finished:
                break

            messages = self._compact(messages)

        # ---------------- 验证阶段 ----------------
        verified: bool | None = None
        if self.config.verify and self.config.allow_commands and toolbox.changed_files:
            verified = await self._verify(toolbox, messages, final_summary)
            self.stats.verified = verified

        self.stats.changed_files = sorted(toolbox.changed_files)
        summary = final_summary or "Agent 未给出总结"
        if not toolbox.changed_files:
            self.log("Agent 未修改任何文件", "warn")

        return {
            "ok": True,
            "summary": summary,
            "steps": self.stats.steps,
            "toolCalls": self.stats.tool_calls,
            "failedCalls": self.stats.failed_calls,
            "changedFiles": self.stats.changed_files,
            "verified": verified,
            "verifyRounds": self.stats.verify_rounds,
            "protocol": self.protocol,
            "usage": self.llm.usage,
        }

    # ------------------------------------------------------------------
    def _stopped(self) -> bool:
        return self.is_cancelled() or time.time() > self.deadline

    def _protocol_suffix(self) -> str:
        if self.protocol == "tools":
            return ""
        names = ", ".join(spec["function"]["name"] for spec in tool_specs())
        return JSON_PROTOCOL.format(tools=names)

    def _task_brief(self, task: str, repo_map: str, instructions: str, plan: str) -> str:
        parts = [
            "## 升级任务",
            task.strip(),
        ]
        if plan.strip():
            parts += ["", "## 升级方案（需落地实现）", plan.strip()[:6000]]
        if instructions.strip():
            parts += ["", "## 项目约定（必须遵守）", instructions.strip()[:3000]]
        parts += [
            "",
            "## 仓库地图（符号索引，帮助你定位文件）",
            repo_map[:9000],
            "",
            "## 工作方式",
            "先用 read_file/grep 确认现状，再用 edit_file 做最小改动，最后跑测试验证。",
            "不要一次性重写多个文件；每轮只推进一个明确的小目标。",
        ]
        return "\n".join(parts)

    # ------------------------------------------------------------------
    async def _decide(self, messages: list[dict[str, Any]]) -> dict[str, Any] | None:
        if self.protocol == "tools":
            try:
                response = await self.llm.chat_tools(messages, tool_specs())
            except LLMError as exc:
                if str(exc) == "tools-unsupported":
                    self.protocol = "json"
                    self.stats.protocol = "json"
                    self.log("模型不支持 tools 协议，自动切换为 JSON 协议", "warn")
                    messages[0] = {"role": "system", "content": SYSTEM_AGENT + self._protocol_suffix()}
                    return await self._decide_json(messages)
                raise
            calls = response.get("tool_calls") or []
            content = (response.get("content") or "").strip()
            reasoning = (response.get("reasoning") or "").strip()
            # 推理模型（DeepSeek reasoner / o 系列）把思考放在 reasoning_content，
            # 这里统一当成「思考」推到界面上，用户能看到它在想什么。
            return {
                "thought": content or reasoning,
                "reasoning": reasoning,
                "calls": calls,
                "content": response.get("content") or "",
            }
        return await self._decide_json(messages)

    async def _decide_json(self, messages: list[dict[str, Any]]) -> dict[str, Any] | None:
        raw = await self.llm.chat(messages, temperature=0.15)
        payload = LLMClient.extract_json(raw)
        if not payload:
            messages.append({"role": "assistant", "content": raw})
            return None
        tool = payload.get("tool") or payload.get("name")
        args = payload.get("args") or payload.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        call = {"id": f"json_{self.stats.steps}", "name": str(tool or ""), "arguments": args}
        return {
            "thought": payload.get("thought") or "",
            "calls": [call] if tool else [],
            "final": payload.get("final") or payload.get("summary"),
            "content": raw,
        }

    # ------------------------------------------------------------------
    async def _execute(self, call: dict[str, Any], toolbox: Toolbox) -> ToolResult:
        name = str(call.get("name") or "")
        args = call.get("arguments") or {}
        started = time.time()
        result = await toolbox.call(name, args if isinstance(args, dict) else {})
        duration = int((time.time() - started) * 1000)
        self.stats.tool_calls += 1
        if not result.ok:
            self.stats.failed_calls += 1
        preview = result.content.replace("\n", " ")[:160]
        self.emit(
            "agent.tool",
            {
                "id": call.get("id") or f"call_{self.stats.tool_calls}",
                "tool": name,
                "args": args if isinstance(args, dict) else {},
                "ok": result.ok,
                "durationMs": duration,
                "observation": result.content[:2000],
                "preview": preview,
            },
            message=f"{name} {'✓' if result.ok else '✗'} {preview}",
        )
        self.log(f"工具 {name} {'成功' if result.ok else '失败'} · {preview[:140]}", "info" if result.ok else "warn")
        return result

    def _format_observation(self, name: str, result: ToolResult) -> str:
        header = f"工具 {name} 返回：" + ("成功" if result.ok else "失败")
        return f"{header}\n{result.content}"

    def _append_observation(
        self,
        messages: list[dict[str, Any]],
        call: dict[str, Any],
        observation: str,
        decision: dict[str, Any],
    ) -> None:
        if self.protocol == "tools":
            messages.append(
                {
                    "role": "assistant",
                    "content": decision.get("thought") or "",
                    "tool_calls": [
                        {
                            "id": call["id"],
                            "type": "function",
                            "function": {
                                "name": call["name"],
                                "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                            },
                        }
                    ],
                }
            )
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": observation})
        else:
            raw = decision.get("content") or json.dumps(
                {"tool": call["name"], "args": call.get("arguments") or {}}, ensure_ascii=False
            )
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": observation})

    def _compact(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        total = sum(len(str(message.get("content") or "")) for message in messages)
        if total <= CONTEXT_CHAR_BUDGET and len(messages) <= 40:
            return messages
        head = messages[:2]
        tail = messages[-10:]
        dropped = len(messages) - len(head) - len(tail)
        if dropped <= 0:
            return messages
        note = {"role": "user", "content": f"（已省略 {dropped} 条较早的工具交互，继续当前任务）"}
        self.log(f"上下文压缩：省略 {dropped} 条较早消息", "debug")
        return head + [note] + tail

    # ------------------------------------------------------------------
    async def _verify(self, toolbox: Toolbox, messages: list[dict[str, Any]], summary: str) -> bool:
        commands = detect_commands(toolbox.root)
        plan = [command for command in (commands.get("test"), commands.get("typecheck")) if command]
        if plan and self.config.allow_commands:
            for round_index in range(MAX_VERIFY_ROUNDS + 1):
                if self._stopped():
                    break
                failed: list[str] = []
                for command in plan[:2]:
                    result = await toolbox._run_shell(command, 300)  # noqa: SLF001 - 复用同一沙箱
                    self.emit(
                        "agent.verify",
                        {
                            "command": command,
                            "ok": result.ok,
                            "exitCode": (result.meta or {}).get("exitCode"),
                            "output": result.content[:3000],
                        },
                        message=f"验证 {command} {'通过' if result.ok else '失败'}",
                    )
                    self.log(f"验证 {command} {'通过' if result.ok else '失败'}", "success" if result.ok else "warn")
                    if not result.ok:
                        failed.append(f"命令 {command} 失败：\n{result.content[:2500]}")
                if not failed:
                    self.stats.verify_rounds = round_index
                    return True
                if round_index >= MAX_VERIFY_ROUNDS:
                    break
                self.stats.verify_rounds = round_index + 1
                messages.append(
                    {
                        "role": "user",
                        "content": "验证未通过，请先分析错误并修复，然后再次运行验证：\n\n" + "\n\n".join(failed),
                    }
                )
                while self.stats.steps < self.config.max_steps and not self._stopped():
                    self.stats.steps += 1
                    decision = await self._decide(messages)
                    if decision is None:
                        break
                    if decision.get("final"):
                        break
                    calls = decision.get("calls") or []
                    if not calls:
                        break
                    for call in calls:
                        result = await self._execute(call, toolbox)
                        self._append_observation(messages, call, self._format_observation(call["name"], result), decision)
                        if toolbox.finished:
                            break
                    messages = self._compact(messages)
                plan = [command for command in (commands.get("test"), commands.get("typecheck")) if command]
            return False
        return True
