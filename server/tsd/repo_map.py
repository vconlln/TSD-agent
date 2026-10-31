from __future__ import annotations

"""给 Agent 的"地图"：仓库结构、符号索引、项目约定与验证命令。

模型本身看不到磁盘，这些确定性信息决定了它第一步有没有方向。
把仓库压缩成几千字符的符号表，比把整仓代码塞进上下文更有效。
"""

import json
import re
from pathlib import Path
from typing import Any

from .utils import is_binary, language_of, read_text, walk_files

SOURCE_EXTS = {
    "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "kt", "cs",
    "rb", "php", "swift", "c", "h", "cpp", "hpp", "vue", "svelte", "scala", "dart",
}

ENTRY_HINTS = (
    "main.", "app.", "index.", "server.", "cli.", "boot.",
    "package.json", "pyproject.toml", "go.mod", "cargo.toml", "pom.xml", "build.gradle",
)

SYMBOL_PATTERNS: dict[str, list[str]] = {
    "py": [r"^(?:async\s+)?def\s+([A-Za-z_]\w*)", r"^class\s+([A-Za-z_]\w*)"],
    "ts": [
        r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
        r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)",
        r"^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)",
        r"^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=",
    ],
    "go": [r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)", r"^type\s+([A-Za-z_]\w*)"],
    "rs": [
        r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)",
        r"^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)",
    ],
    "java": [
        r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)",
        r"^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\], ]+\s+([A-Za-z_]\w*)\s*\(",
    ],
}

INSTRUCTION_FILES = (
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".cursor/rules",
    ".github/copilot-instructions.md",
    "CONTRIBUTING.md",
)


def _patterns_for(path: str) -> list[str]:
    ext = path.rsplit(".", 1)[-1].lower()
    if ext in {"ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte"}:
        return SYMBOL_PATTERNS["ts"]
    if ext in {"java", "kt", "cs", "scala"}:
        return SYMBOL_PATTERNS["java"]
    return SYMBOL_PATTERNS.get(ext, [])


def extract_symbols(path: str, text: str, limit: int = 10) -> list[str]:
    patterns = _patterns_for(path)
    if not patterns:
        return []
    found: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.M):
            name = match.group(1)
            if name and name not in found:
                found.append(name)
            if len(found) >= limit:
                return found
    return found


def build_repo_map(root: Path, max_chars: int = 9000, max_files: int = 400) -> str:
    """生成紧凑的仓库地图：语言、规模、关键符号。"""
    if not root.exists():
        return "（代码目录不存在）"

    entries: list[tuple[int, str, str]] = []
    total_files = 0
    for rel, size in walk_files(root):
        total_files += 1
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
        lower = rel.lower()
        priority = 0
        if any(lower.endswith(hint) or lower == hint for hint in ENTRY_HINTS):
            priority -= 2
        if "test" in lower or "spec" in lower:
            priority += 1
        if ext not in SOURCE_EXTS:
            priority += 2
        if size > 400_000:
            priority += 1
        entries.append((priority, rel, ext))

    entries.sort(key=lambda item: (item[0], item[1]))
    lines: list[str] = []
    used = 0
    shown = 0
    for _priority, rel, ext in entries[:max_files]:
        file_path = root / rel
        detail = ""
        if ext in SOURCE_EXTS:
            text, _truncated = read_text(file_path, 200_000)
            if text:
                symbols = extract_symbols(rel, text)
                line_count = text.count("\n") + 1
                detail = f" ({language_of(rel) or ext}, {line_count} 行)"
                if symbols:
                    detail += ": " + ", ".join(symbols)
        else:
            detail = " (" + (language_of(rel) or (ext + " 文件" if ext else "文件")) + ")"
        line = f"- {rel}{detail}"
        if used + len(line) > max_chars:
            lines.append(f"- …其余 {max(0, total_files - shown)} 个文件未展开")
            break
        lines.append(line)
        used += len(line) + 1
        shown += 1

    header = f"仓库共 {total_files} 个文件，以下按重要性排列："
    return header + "\n" + "\n".join(lines)


def read_project_instructions(root: Path, max_chars: int = 4000) -> str:
    """读取项目自带的编码约定（AGENTS.md 等），作为 Agent 的强约束。"""
    for name in INSTRUCTION_FILES:
        candidate = root / name
        if candidate.is_file():
            text, _ = read_text(candidate, 200_000)
            text = text.strip()
            if text:
                return f"来源：{name}\n\n{text[:max_chars]}"
    return ""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return {}


def detect_commands(root: Path) -> dict[str, str | None]:
    """探测项目的测试 / 类型检查 / 静态检查命令。"""
    commands: dict[str, str | None] = {"test": None, "typecheck": None, "lint": None}

    package_json = root / "package.json"
    if package_json.exists():
        data = _read_json(package_json)
        scripts = data.get("scripts") or {}
        if isinstance(scripts, dict):
            for key, target in (
                ("test", "test"),
                ("typecheck", "typecheck"),
                ("type-check", "typecheck"),
                ("lint", "lint"),
            ):
                if isinstance(scripts.get(key), str):
                    commands[target] = f"npm run {key}"

    pyproject = root / "pyproject.toml"
    has_pytest = (
        pyproject.exists() and "pytest" in (pyproject.read_text("utf-8", errors="ignore") if pyproject.exists() else "")
    ) or (root / "tests").is_dir() or any(root.glob("test_*.py")) or any(root.glob("*_test.py"))
    if has_pytest and commands["test"] is None:
        # POSIX 上通常只有 python3；Windows 安装器提供的是 python
        interpreter = "python" if __import__("os").name == "nt" else "python3"
        commands["test"] = f"{interpreter} -m pytest -q"
    if (root / "mypy.ini").exists() or (root / "pyrightconfig.json").exists():
        commands["typecheck"] = commands["typecheck"] or "python -m mypy ."
    if pyproject.exists():
        text = pyproject.read_text("utf-8", errors="ignore")
        if "[tool.ruff" in text:
            commands["lint"] = commands["lint"] or "python -m ruff check ."

    if (root / "go.mod").exists():
        commands["test"] = commands["test"] or "go test ./..."
        commands["lint"] = commands["lint"] or "go vet ./..."
    if (root / "Cargo.toml").exists():
        commands["test"] = commands["test"] or "cargo test --quiet"
        commands["typecheck"] = commands["typecheck"] or "cargo check --quiet"
    if (root / "pom.xml").exists():
        commands["test"] = commands["test"] or "mvn -q -DskipTests=false test"

    return commands
