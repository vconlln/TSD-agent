from __future__ import annotations

"""Agent 的"手"：在沙箱内读写文件、搜索、执行验证命令。

所有路径都限制在升级结果目录内；命令有白名单、超时与输出上限。
工具返回的是"观察结果"，会作为下一条消息回喂给模型——这是 Agent 能自我纠错的
关键：读错文件、改错位置、测试失败，都能在下一轮被模型看到并修正。
"""

import asyncio
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .repo_map import detect_commands
from .utils import is_binary, read_text, walk_files

MAX_READ_LINES = 400
MAX_WRITE_BYTES = 800_000
MAX_GREP_MATCHES = 100
MAX_SCAN_BYTES = 500_000

ALLOWED_PROGRAMS = {
    "python", "python3", "py", "pytest", "uv", "pip", "pip3",
    "npm", "npx", "pnpm", "yarn", "node", "bun", "deno",
    "go", "cargo", "rustc", "make", "cmake", "ninja",
    "tsc", "eslint", "prettier", "jest", "vitest", "mocha",
    "ruff", "black", "mypy", "pyright", "flake8",
    "javac", "java", "mvn", "gradle", "./gradlew", "dotnet",
    "php", "composer", "ruby", "bundle", "rake", "dart", "flutter",
    "gcc", "g++", "clang", "clang++", "zig", "swift",
}

DENY_PATTERNS = [
    r"\bsudo\b",
    r"\brm\s+-[a-z]*[rf]",
    r"\bmkfs\b",
    r"\bdd\s+if=",
    r"\bshutdown\b",
    r"\breboot\b",
    r">\s*/dev/",
    r"\bchmod\s+-R\b",
    r"\bchown\s+-R\b",
    r"\bgit\s+(push|commit|reset|checkout|clean)\b",
    r"\bcurl\b[^|]*\|\s*(sh|bash)",
    r"\bwget\b[^|]*\|\s*(sh|bash)",
    r"\b(sh|bash)\s+-c\b.*\|\s*(sh|bash)",
]


def tool_specs() -> list[dict[str, Any]]:
    """OpenAI function calling 用的工具声明。描述里写清使用时机，模型才用得对。"""
    return [
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "按 glob 列出仓库里的文件（相对于项目根目录）。用于确认目录结构与文件是否存在。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "glob，例如 src/**/*.ts；默认 **/*"},
                        "limit": {"type": "integer", "description": "最多返回多少条，默认 200"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取文件内容（带行号）。修改前必须先读，确保后续 edit_file 的 old_string 与文件完全一致。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "相对路径，例如 src/auth.ts"},
                        "start_line": {"type": "integer", "description": "起始行，默认 1"},
                        "end_line": {"type": "integer", "description": "结束行，默认根据文件长度"},
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "按正则搜索文件内容，返回 路径:行号: 内容。用于定位符号、配置项、旧实现。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "正则表达式"},
                        "include": {"type": "string", "description": "可选 glob 过滤，例如 *.ts"},
                        "limit": {"type": "integer", "description": "最多匹配数，默认 80"},
                    },
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "把文件中一段完全一致的文本替换为新文本。old_string 必须唯一（否则需提供更多上下文或设 replace_all）。改完请回读确认。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old_string": {"type": "string", "description": "要替换的原文，需与文件内容逐字一致（含缩进）"},
                        "new_string": {"type": "string", "description": "替换后的文本"},
                        "replace_all": {"type": "boolean", "description": "是否替换所有匹配，默认 false"},
                    },
                    "required": ["path", "old_string", "new_string"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "写入（覆盖）整个文件。仅用于新建文件，或整文件重写；局部修改优先用 edit_file。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "删除一个文件（相对路径）。",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "在项目根目录执行一条构建/测试/检查命令（白名单：npm/pytest/go/cargo/tsc/ruff 等）。用于验证改动是否可用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "例如 npm test 或 python -m pytest -q"},
                        "timeout_seconds": {"type": "integer", "description": "超时秒数，默认 120，上限 600"},
                    },
                    "required": ["command"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_tests",
                "description": "自动探测并运行项目测试命令（package.json scripts.test / pytest / go test / cargo test）。",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "finish",
                "description": "任务完成时调用，给出中文总结：改了哪些文件、为什么、验证结果如何。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string", "description": "改动总结与验证结论"},
                        "changed_files": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "本次改动的文件列表",
                        },
                    },
                    "required": ["summary"],
                },
            },
        },
    ]


@dataclass
class ToolResult:
    ok: bool
    content: str
    meta: dict[str, Any] = field(default_factory=dict)


class Toolbox:
    def __init__(
        self,
        root: Path,
        *,
        allow_commands: bool = True,
        max_output: int = 6000,
        default_timeout: int = 120,
    ) -> None:
        self.root = root.resolve()
        self.allow_commands = allow_commands
        self.max_output = max_output
        self.default_timeout = default_timeout
        self.changed_files: set[str] = set()
        self.finished = False
        self.summary = ""

    # ------------------------------------------------------------------
    def _resolve(self, raw: str) -> Path:
        if not raw or not isinstance(raw, str):
            raise ValueError("缺少路径")
        candidate = (self.root / raw.strip().lstrip("/\\")).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise ValueError(f"路径越界：{raw}") from exc
        return candidate

    def _truncate(self, text: str) -> str:
        if len(text) <= self.max_output:
            return text
        head = text[: self.max_output // 3]
        tail = text[-self.max_output // 3 :]
        return f"{head}\n…（输出过长已截断）…\n{tail}"

    # ------------------------------------------------------------------
    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        handler = getattr(self, f"_tool_{name}", None)
        if handler is None:
            return ToolResult(False, f"未知工具：{name}")
        try:
            return await handler(args or {})
        except ValueError as exc:
            return ToolResult(False, f"参数错误：{exc}")
        except Exception as exc:  # noqa: BLE001
            return ToolResult(False, f"工具执行失败：{exc}")

    # ------------------------------------------------------------------
    async def _tool_list_files(self, args: dict[str, Any]) -> ToolResult:
        pattern = str(args.get("pattern") or "**/*").strip()
        limit = min(int(args.get("limit") or 200), 500)
        base = self.root
        results: list[str] = []
        for path in sorted(base.glob(pattern)):
            if not path.is_file():
                continue
            rel = path.relative_to(self.root).as_posix()
            if rel.startswith(".git/") or "/node_modules/" in rel or rel.startswith("node_modules/"):
                continue
            size = path.stat().st_size
            results.append(f"{rel} ({size} B)")
            if len(results) >= limit:
                break
        if not results:
            return ToolResult(True, f"没有匹配 {pattern} 的文件")
        return ToolResult(True, "\n".join(results))

    async def _tool_read_file(self, args: dict[str, Any]) -> ToolResult:
        path = self._resolve(str(args.get("path") or ""))
        if not path.exists() or not path.is_file():
            return ToolResult(False, f"文件不存在：{args.get('path')}")
        if is_binary(path):
            return ToolResult(False, "二进制文件无法读取")
        text, truncated = read_text(path, 1_500_000)
        lines = text.split("\n")
        total = len(lines)
        start = max(1, int(args.get("start_line") or 1))
        end = int(args.get("end_line") or 0) or total
        end = min(max(start, end), total, start + MAX_READ_LINES - 1)
        body = "\n".join(f"{number:>5}| {lines[number - 1]}" for number in range(start, end + 1))
        note = ""
        if truncated:
            note = "\n…（文件过大，仅读取前 1.5MB）"
        if end < total:
            note += f"\n…（共 {total} 行，已显示到第 {end} 行，可再次调用读取后续）"
        return ToolResult(True, f"{args.get('path')}（{start}-{end}/{total} 行）\n{body}{note}")

    async def _tool_grep(self, args: dict[str, Any]) -> ToolResult:
        pattern = str(args.get("pattern") or "")
        if not pattern:
            return ToolResult(False, "缺少 pattern")
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            return ToolResult(False, f"正则不合法：{exc}")
        include = str(args.get("include") or "").strip()
        limit = min(int(args.get("limit") or 80), MAX_GREP_MATCHES)
        matches: list[str] = []
        for rel, size in walk_files(self.root):
            if size > MAX_SCAN_BYTES:
                continue
            if include and not Path(rel).match(include):
                continue
            file_path = self.root / rel
            if is_binary(file_path):
                continue
            text, _ = read_text(file_path, MAX_SCAN_BYTES)
            if not text:
                continue
            for number, line in enumerate(text.split("\n"), 1):
                if regex.search(line):
                    snippet = line.strip()[:200]
                    matches.append(f"{rel}:{number}: {snippet}")
                    if len(matches) >= limit:
                        break
            if len(matches) >= limit:
                break
        if not matches:
            return ToolResult(True, f"没有匹配 /{pattern}/ 的内容")
        return ToolResult(True, "\n".join(matches))

    async def _tool_edit_file(self, args: dict[str, Any]) -> ToolResult:
        path = self._resolve(str(args.get("path") or ""))
        if not path.exists():
            return ToolResult(False, f"文件不存在：{args.get('path')}（新建文件请用 write_file）")
        old = args.get("old_string")
        new = args.get("new_string")
        if not isinstance(old, str) or not isinstance(new, str) or not old:
            return ToolResult(False, "old_string / new_string 必填")
        if old == new:
            return ToolResult(False, "old_string 与 new_string 相同，没有改动")
        text, _ = read_text(path, 1_500_000)
        count = text.count(old)
        if count == 0:
            hint = self._nearest_line_hint(text, old)
            return ToolResult(
                False,
                "未找到完全一致的 old_string。请先 read_file 核对原文（含缩进与空行），或改用更短的唯一片段。"
                + (f"\n{hint}" if hint else ""),
            )
        if count > 1 and not args.get("replace_all"):
            return ToolResult(False, f"old_string 在文件中出现了 {count} 次，请补充上下文使其唯一，或设置 replace_all=true")
        updated = text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1)
        path.write_text(updated, "utf-8")
        rel = path.relative_to(self.root).as_posix()
        self.changed_files.add(rel)
        delta = new.count("\n") - old.count("\n")
        return ToolResult(True, f"已修改 {rel}（行数变化 {delta:+d}）")

    async def _tool_write_file(self, args: dict[str, Any]) -> ToolResult:
        path = self._resolve(str(args.get("path") or ""))
        content = args.get("content")
        if not isinstance(content, str):
            return ToolResult(False, "content 必须是字符串")
        if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
            return ToolResult(False, "内容超过 800KB 上限")
        existed = path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, "utf-8")
        rel = path.relative_to(self.root).as_posix()
        self.changed_files.add(rel)
        action = "覆盖写入" if existed else "新建"
        return ToolResult(True, f"{action} {rel}（{len(content.encode('utf-8'))} B）")

    async def _tool_delete_file(self, args: dict[str, Any]) -> ToolResult:
        path = self._resolve(str(args.get("path") or ""))
        if not path.exists():
            return ToolResult(False, "文件不存在")
        path.unlink()
        rel = path.relative_to(self.root).as_posix()
        self.changed_files.add(rel)
        return ToolResult(True, f"已删除 {rel}")

    # ------------------------------------------------------------------
    def _command_problem(self, command: str) -> str | None:
        if not self.allow_commands:
            return "当前配置禁止执行命令（可在设置中打开「允许运行验证命令」）"
        for pattern in DENY_PATTERNS:
            if re.search(pattern, command):
                return f"命令被安全策略拒绝（匹配 /{pattern}/）"
        program = command.strip().split()[0] if command.strip() else ""
        program = program.lstrip("./")
        if program not in ALLOWED_PROGRAMS:
            return f"命令 {program} 不在白名单内（允许：npm / pytest / go / cargo / tsc / ruff 等）"
        return None

    async def _run_shell(self, command: str, timeout: int) -> ToolResult:
        problem = self._command_problem(command)
        if problem:
            return ToolResult(False, problem)
        env = {
            **os.environ,
            "CI": "1",
            "NO_COLOR": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "PYTHONUNBUFFERED": "1",
        }
        try:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(self.root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
        except Exception as exc:  # noqa: BLE001
            return ToolResult(False, f"无法启动命令：{exc}")
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
            code = process.returncode
        except asyncio.TimeoutError:
            try:
                process.kill()
            except Exception:
                pass
            return ToolResult(False, f"命令超时（{timeout}s）：{command}")
        output = (stdout or b"").decode("utf-8", "replace").strip()
        ok = code == 0
        header = f"$ {command}\n退出码 {code}\n"
        body = output if output else "（无输出）"
        return ToolResult(ok, self._truncate(header + body), {"exitCode": code})

    async def _tool_run_command(self, args: dict[str, Any]) -> ToolResult:
        command = str(args.get("command") or "").strip()
        if not command:
            return ToolResult(False, "缺少 command")
        timeout = min(int(args.get("timeout_seconds") or self.default_timeout), 600)
        return await self._run_shell(command, timeout)

    async def _tool_run_tests(self, args: dict[str, Any]) -> ToolResult:
        commands = detect_commands(self.root)
        command = commands.get("test")
        if not command:
            return ToolResult(False, "没有探测到测试命令（可在项目里配置 npm test / pytest / go test）")
        return await self._run_shell(command, 300)

    async def _tool_finish(self, args: dict[str, Any]) -> ToolResult:
        self.finished = True
        self.summary = str(args.get("summary") or "").strip()
        files = args.get("changed_files")
        if isinstance(files, list):
            self.changed_files.update(str(item) for item in files if isinstance(item, str))
        return ToolResult(True, "任务已结束")

    # ------------------------------------------------------------------
    def _nearest_line_hint(self, text: str, needle: str) -> str:
        key = next((line.strip() for line in needle.split("\n") if line.strip()), "")
        if not key:
            return ""
        key = key[:60]
        for number, line in enumerate(text.split("\n"), 1):
            if key and key in line:
                return f"第 {number} 行包含相近内容：{line.strip()[:120]}"
        return ""
