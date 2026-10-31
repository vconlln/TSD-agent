from __future__ import annotations

"""编辑器内 AI：解释选中代码、按指令改写选区（Cursor 式交互的服务端部分）。

前端把编辑器的当前内容（可能尚未保存）连同选区一起发来，这里：
- 让模型只返回“选区替换文本”，降低整文件重写的风险；
- 用 difflib 生成统一补丁，供前端展示接受 / 拒绝；
- 未配置模型时解释接口退化为结构化静态分析，修改接口给出明确提示。
"""

import re
from typing import Any

from .config import SettingsStore
from .diffing import _patch_for
from .llm import LLMClient, LLMError
from .store import ProjectStore
from .utils import is_binary, language_of, read_text, safe_join

MAX_FILE_CHARS = 200_000
MAX_SELECTION_LINES = 400

SYSTEM_EDIT = (
    "你是资深工程师，负责在一个既有代码库里精确修改用户选中的代码。"
    "只输出 JSON，不要输出解释性文字或 Markdown 代码围栏。"
    "replacement 必须是可直接替换选中行的完整代码文本，保持一致缩进与引号风格。"
)

SYSTEM_EXPLAIN = (
    "你是资深工程师，负责向同事解释一段代码。"
    "用简体中文输出 Markdown：先一句话结论，再分点说明作用、关键逻辑、潜在风险或改进点。"
    "不要复述整段代码，不要使用二级以上标题。"
)

FENCE_RE = re.compile(r"^\s*\x60\x60\x60[\w+-]*\s*\n([\s\S]*?)\n?\x60\x60\x60\s*$")


class InlineAgentError(RuntimeError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _strip_fence(text: str) -> str:
    match = FENCE_RE.match(text or "")
    return match.group(1) if match else (text or "")


class InlineAgent:
    def __init__(self, store: ProjectStore, settings: SettingsStore) -> None:
        self.store = store
        self.settings = settings

    # ------------------------------------------------------------------
    def _resolve(self, project: dict[str, Any], path: str) -> tuple[str, str]:
        target = self.store.target_dir(project)
        if not target.exists():
            raise InlineAgentError("升级结果目录不存在，请先执行升级", 409)
        if not path:
            raise InlineAgentError("缺少文件路径", 400)
        try:
            file_path = safe_join(target, path)
        except ValueError as exc:
            raise InlineAgentError("非法文件路径", 400) from exc
        if not file_path.exists() or not file_path.is_file():
            raise InlineAgentError("文件不存在", 404)
        if is_binary(file_path):
            raise InlineAgentError("二进制文件不支持 AI 编辑", 400)
        content, truncated = read_text(file_path, MAX_FILE_CHARS)
        if truncated:
            raise InlineAgentError("文件过大，暂不支持 AI 编辑", 413)
        return path, content

    @staticmethod
    def _selection_bounds(content: str, start_line: int, end_line: int) -> tuple[int, int, int]:
        lines = content.split("\n")
        total = len(lines)
        start = max(1, min(start_line or 1, total))
        end = max(start, min(end_line or start, total))
        if end - start + 1 > MAX_SELECTION_LINES:
            raise InlineAgentError(f"选中行数过多（上限 {MAX_SELECTION_LINES} 行）", 413)
        start_offset = sum(len(line) + 1 for line in lines[: start - 1])
        end_offset = sum(len(line) + 1 for line in lines[:end]) - 1
        return start_offset, max(start_offset, end_offset), end - start + 1

    # ------------------------------------------------------------------
    async def edit(
        self,
        project: dict[str, Any],
        path: str,
        instruction: str,
        start_line: int = 0,
        end_line: int = 0,
        content: str | None = None,
    ) -> dict[str, Any]:
        instruction = (instruction or "").strip()
        if not instruction:
            raise InlineAgentError("请描述要做的修改", 400)
        rel, current = self._resolve(project, path)
        if isinstance(content, str):
            current = content

        selection_mode = bool(start_line and end_line)
        if selection_mode:
            start_offset, end_offset, line_count = self._selection_bounds(current, start_line, end_line)
        else:
            start_offset, end_offset, line_count = 0, len(current), len(current.split("\n"))

        engine = self.settings.engine()
        llm = LLMClient(engine)
        if not llm.available():
            return {
                "ok": False,
                "mode": "offline",
                "error": "未配置可用的推理引擎，暂时无法生成代码修改。请在设置中配置模型，或通过 W3 凭证接入模型服务。",
                "path": rel,
            }

        scope_text = (
            f"替换第 {start_line} 到 {end_line} 行" if selection_mode else "重写整个文件"
        )
        selection_block = ""
        if selection_mode:
            selection_block = "\n<selection>\n" + current[start_offset:end_offset] + "\n</selection>\n"

        messages = [
            {"role": "system", "content": SYSTEM_EDIT},
            {
                "role": "user",
                "content": (
                    f"项目：{project.get('name')}（目标版本 v{project.get('targetVersion')}）\n"
                    f"文件：{rel}（{language_of(rel) or 'text'}）\n"
                    f"任务：{scope_text}\n"
                    f"{selection_block}\n"
                    "<file>\n"
                    f"{current[:60_000]}\n"
                    "</file>\n\n"
                    f"<requirement>\n{instruction}\n</requirement>\n\n"
                    "只输出 JSON："
                    '{"summary":"一句话说明改了什么","rationale":"简短理由",'
                    '"replacement":"用于替换选中行的完整代码文本（不含行号与代码围栏）"}'
                ),
            },
        ]

        try:
            payload = await llm.chat_json(messages, max_tokens=min(llm.max_tokens, 8000), temperature=0.2)
        except LLMError as exc:
            raise InlineAgentError(f"模型调用失败：{exc}", 502) from exc
        if not payload or not isinstance(payload.get("replacement"), str):
            raise InlineAgentError("模型未返回可用的修改内容", 502)

        replacement = _strip_fence(str(payload["replacement"]))
        after = current[:start_offset] + replacement + current[end_offset:]
        patch, additions, deletions = _patch_for(current, after, rel)
        return {
            "ok": True,
            "mode": "llm",
            "model": llm.model,
            "path": rel,
            "scope": "selection" if selection_mode else "file",
            "startLine": start_line if selection_mode else 1,
            "endLine": end_line if selection_mode else len(current.split("\n")),
            "summary": str(payload.get("summary") or "代码修改").strip(),
            "rationale": str(payload.get("rationale") or "").strip(),
            "replacement": replacement,
            "before": current,
            "after": after,
            "patch": patch,
            "additions": additions,
            "deletions": deletions,
        }

    # ------------------------------------------------------------------
    async def explain(
        self,
        project: dict[str, Any],
        path: str,
        start_line: int = 0,
        end_line: int = 0,
        content: str | None = None,
        question: str | None = None,
    ) -> dict[str, Any]:
        rel, current = self._resolve(project, path)
        if isinstance(content, str):
            current = content

        selection_mode = bool(start_line and end_line)
        if selection_mode:
            start_offset, end_offset, line_count = self._selection_bounds(current, start_line, end_line)
            snippet = current[start_offset:end_offset]
        else:
            snippet = current
            line_count = len(current.split("\n"))

        engine = self.settings.engine()
        llm = LLMClient(engine)
        if not llm.available():
            return {
                "ok": True,
                "mode": "offline",
                "text": _heuristic_explanation(rel, snippet, selection_mode, line_count),
                "path": rel,
            }

        where = f"第 {start_line} 到 {end_line} 行" if selection_mode else "整个文件"
        messages = [
            {"role": "system", "content": SYSTEM_EXPLAIN},
            {
                "role": "user",
                "content": (
                    f"文件：{rel}（{language_of(rel) or 'text'}），{where}。\n\n"
                    f"<code>\n{snippet[:20_000]}\n</code>\n\n"
                    + (f"用户的问题：{question}\n" if question else "")
                ),
            },
        ]
        try:
            text = await llm.chat(messages, max_tokens=1500, temperature=0.2)
        except LLMError as exc:
            raise InlineAgentError(f"模型调用失败：{exc}", 502) from exc
        return {"ok": True, "mode": "llm", "model": llm.model, "text": text.strip(), "path": rel}


def _heuristic_explanation(rel: str, snippet: str, selection: bool, line_count: int) -> str:
    lines = [line for line in snippet.splitlines() if line.strip()]
    imports = [
        line.strip()
        for line in lines
        if re.match(r"^\s*(import|from|require\(|#include|using )", line)
    ]
    functions = re.findall(r"(?:def|function|func|fn)\s+([A-Za-z_$][\w$]*)", snippet)
    classes = re.findall(r"(?:class|interface|struct|enum)\s+([A-Za-z_$][\w$]*)", snippet)
    exports = re.findall(
        r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)",
        snippet,
        re.M,
    )
    parts = [
        f"**概览**：{rel} 的{'选段' if selection else '整体'}，约 {line_count} 行、{len(lines)} 行非空。"
    ]
    if imports:
        parts.append("**依赖**：" + "、".join(f"「{item}」" for item in imports[:6]))
    if classes:
        parts.append("**类型/类**：" + "、".join(f"「{name}」" for name in classes[:6]))
    if functions:
        parts.append("**函数**：" + "、".join(f"「{name}」" for name in functions[:8]))
    if exports:
        parts.append("**导出**：" + "、".join(f"「{name}」" for name in exports[:8]))
    parts.append(
        "> 当前为离线分析（未配置模型），只做结构与符号层面的说明；"
        "配置推理引擎后可获得逐行语义解释与修改建议。"
    )
    return "\n\n".join(parts)
