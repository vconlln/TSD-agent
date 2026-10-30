from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path
from typing import Iterator

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".cache",
    ".idea",
    ".vscode",
    "target",
    "vendor",
    ".gradle",
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "logs",
}

BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".psd",
    ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".whl",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".pyc", ".o", ".a", ".lib",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac", ".ogg", ".webm",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".sqlite", ".db", ".lock", ".wasm",
}

MAX_FILE_BYTES = 1_600_000


def now_ms() -> int:
    return int(time.time() * 1000)


def slugify(name: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", (name or "").strip().lower()).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return cleaned or "project"


def human_size(size: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def has_binary_ext(name: str) -> bool:
    """仅根据扩展名判断（用于尚未落盘的新文件）。"""
    return Path(name).suffix.lower() in BINARY_EXT


def is_binary(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXT:
        return True
    try:
        with path.open("rb") as fh:
            chunk = fh.read(2048)
        return b"\x00" in chunk
    except Exception:
        return True


def read_text(path: Path, limit: int = MAX_FILE_BYTES) -> tuple[str, bool]:
    """读取文本，返回 (内容, 是否被截断)。"""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            raw = fh.read(limit)
        text = raw.decode("utf-8", "replace")
        if len(raw) < size:
            return text, True
        return text, False
    except Exception:
        return "", False


def safe_join(root: Path, rel: str) -> Path:
    root_resolved = root.resolve()
    candidate = (root / rel.lstrip("/\\")).resolve()
    if not str(candidate).startswith(str(root_resolved)):
        raise ValueError("路径越界")
    return candidate


def walk_files(root: Path, max_files: int = 6000) -> Iterator[tuple[str, int]]:
    if not root.exists():
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".tsd")]
        for filename in filenames:
            if filename in {".DS_Store", "Thumbs.db"}:
                continue
            full = Path(dirpath) / filename
            try:
                size = full.stat().st_size
            except OSError:
                continue
            rel = full.relative_to(root).as_posix()
            yield rel, size
            count += 1
            if count >= max_files:
                return


def file_hash(path: Path) -> str:
    digest = hashlib.sha1()
    try:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except Exception:
        return ""


def dir_hash_map(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for rel, _size in walk_files(root):
        full = root / rel
        result[rel] = file_hash(full)
    return result


LANG_BY_EXT = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript",
    ".tsx": "TypeScript", ".java": "Java", ".go": "Go", ".rs": "Rust", ".c": "C",
    ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".rb": "Ruby", ".php": "PHP",
    ".kt": "Kotlin", ".swift": "Swift", ".vue": "Vue", ".svelte": "Svelte",
    ".css": "CSS", ".scss": "SCSS", ".html": "HTML", ".sql": "SQL", ".sh": "Shell",
    ".md": "Markdown", ".json": "JSON", ".yml": "YAML", ".yaml": "YAML", ".xml": "XML",
}


def language_of(path: str) -> str:
    return LANG_BY_EXT.get(Path(path).suffix.lower(), "")


IMPORTANT_NAMES = {
    "readme.md", "readme.txt", "readme", "package.json", "pyproject.toml", "setup.py",
    "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "cargo.toml",
    "go.mod", "composer.json", "gemfile", "dockerfile", "docker-compose.yml",
    "makefile", "main.py", "app.py", "manage.py", "main.go", "main.rs", "index.js",
    "index.ts", "main.ts", "main.tsx", "app.tsx", "app.vue", "application.yml",
    "application.properties", "config.py", "settings.py", "tsconfig.json",
}


def is_important(rel: str) -> bool:
    name = Path(rel).name.lower()
    return name in IMPORTANT_NAMES


def detect_version(root: Path) -> str | None:
    """从常见项目文件中探测版本号。"""
    candidates = [
        (root / "package.json", r'"version"\s*:\s*"([^"]+)"'),
        (root / "pyproject.toml", r'(?m)^\s*version\s*=\s*"([^"]+)"'),
        (root / "Cargo.toml", r'(?m)^\s*version\s*=\s*"([^"]+)"'),
        (root / "pom.xml", r"<version>([^<]+)</version>"),
        (root / "setup.py", r"version\s*=\s*['\"]([^'\"]+)['\"]"),
        (root / "VERSION", r"([0-9]+\.[0-9]+(?:\.[0-9]+)?)"),
        (root / "version.txt", r"([0-9]+\.[0-9]+(?:\.[0-9]+)?)"),
    ]
    for path, pattern in candidates:
        if not path.exists():
            continue
        text, _ = read_text(path, 200_000)
        match = re.search(pattern, text)
        if match:
            value = match.group(1).strip()
            if re.fullmatch(r"[0-9A-Za-z._-]{1,24}", value):
                return value
    return None


def bump_version(version: str, part: str = "minor") -> str:
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", version or "")
    if not match:
        return "1.1.0"
    major, minor, patch = match.group(1), match.group(2), match.group(3) or "0"
    if part == "major":
        return f"{int(major) + 1}.0.0"
    if part == "patch":
        return f"{major}.{minor}.{int(patch) + 1}"
    return f"{major}.{int(minor) + 1}.0"


def copy_tree(src: Path, dest: Path) -> int:
    """复制目录（跳过依赖与构建产物），返回复制的文件数。"""
    import shutil

    count = 0
    dest.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel_dir = Path(dirpath).relative_to(src)
        target_dir = dest / rel_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        for filename in filenames:
            source_file = Path(dirpath) / filename
            if source_file.is_symlink():
                continue
            try:
                shutil.copy2(source_file, target_dir / filename)
                count += 1
            except Exception:
                continue
    return count
