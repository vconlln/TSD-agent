from __future__ import annotations

import difflib
import hashlib
import re
from pathlib import Path
from typing import Any

from .utils import MAX_FILE_BYTES, file_hash, is_binary, language_of, now_ms, read_text, walk_files

MAX_PATCH_LINES = 4000
MAX_FILES = 1500
MAX_TOTAL_PATCH_CHARS = 6_000_000


def _split_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").splitlines()


def _patch_for(a_text: str, b_text: str, path: str) -> tuple[str, int, int]:
    a_lines = _split_lines(a_text)
    b_lines = _split_lines(b_text)
    truncated = False
    if len(a_lines) > MAX_PATCH_LINES * 3:
        a_lines = a_lines[: MAX_PATCH_LINES * 3]
        truncated = True
    if len(b_lines) > MAX_PATCH_LINES * 3:
        b_lines = b_lines[: MAX_PATCH_LINES * 3]
        truncated = True
    diff = list(
        difflib.unified_diff(
            a_lines,
            b_lines,
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
            n=3,
        )
    )
    additions = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
    deletions = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
    if len(diff) > MAX_PATCH_LINES:
        diff = diff[:MAX_PATCH_LINES] + ["@@ 差异过大，已截断 @@"]
        truncated = True
    if truncated and diff:
        diff.append("@@ 文件过长，仅比对前 12000 行 @@")
    return "\n".join(diff), additions, deletions


def compute_diffs(source_root: Path, target_root: Path) -> dict[str, Any]:
    """逐文件比对 source 与 target，输出统一差异。"""
    source_files: dict[str, int] = {}
    target_files: dict[str, int] = {}
    if source_root.exists():
        source_files = {rel: size for rel, size in walk_files(source_root)}
    if target_root.exists():
        target_files = {rel: size for rel, size in walk_files(target_root)}

    # content hash for rename detection
    def hashes(root: Path, rels: list[str]) -> dict[str, str]:
        return {rel: file_hash(root / rel) for rel in rels}

    only_source = [rel for rel in source_files if rel not in target_files]
    only_target = [rel for rel in target_files if rel not in source_files]
    source_hashes = hashes(source_root, only_source)
    target_hashes = hashes(target_root, only_target)
    renamed: dict[str, str] = {}
    for src_rel, src_hash in source_hashes.items():
        for tgt_rel, tgt_hash in target_hashes.items():
            if src_hash and src_hash == tgt_hash and src_rel not in renamed and tgt_rel not in renamed.values():
                renamed[src_rel] = tgt_rel
                break

    files: list[dict[str, Any]] = []
    total_chars = 0

    def add_entry(rel: str, status: str, old_rel: str | None = None) -> None:
        nonlocal total_chars
        if len(files) >= MAX_FILES:
            return
        src_path = source_root / (old_rel or rel)
        tgt_path = target_root / rel
        is_new = status == "added"
        is_del = status == "deleted"
        probe = tgt_path if not is_del else src_path
        language = language_of(rel)

        if probe.exists() and (is_binary(probe) or probe.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff2", ".pdf", ".zip"}):
            files.append(
                {
                    "path": rel,
                    "oldPath": old_rel,
                    "status": status,
                    "additions": 0,
                    "deletions": 0,
                    "patch": f"--- a/{old_rel or rel}\n+++ b/{rel}\n二进制文件已变更",
                    "binary": True,
                    "language": language,
                }
            )
            return

        a_text, a_trunc = ("", False) if is_new else read_text(src_path)
        b_text, b_trunc = ("", False) if is_del else read_text(tgt_path)
        patch, additions, deletions = _patch_for(a_text, b_text, rel)
        total_chars += len(patch)
        if total_chars > MAX_TOTAL_PATCH_CHARS:
            return
        files.append(
            {
                "path": rel,
                "oldPath": old_rel,
                "status": status,
                "additions": additions,
                "deletions": deletions,
                "patch": patch,
                "truncated": a_trunc or b_trunc,
                "language": language,
            }
        )

    for rel in sorted(target_files):
        if rel in source_files:
            src_path = source_root / rel
            tgt_path = target_root / rel
            try:
                if src_path.stat().st_size == tgt_path.stat().st_size and file_hash(src_path) == file_hash(tgt_path):
                    continue
            except OSError:
                continue
            add_entry(rel, "modified")
        elif rel in renamed.values():
            continue
        else:
            add_entry(rel, "added")

    for rel in sorted(source_files):
        if rel in target_files:
            continue
        if rel in renamed:
            add_entry(renamed[rel], "renamed", old_rel=rel)
        else:
            add_entry(rel, "deleted")

    additions = sum(f["additions"] for f in files)
    deletions = sum(f["deletions"] for f in files)
    files.sort(key=lambda f: (f["status"] != "modified", -f["additions"] - f["deletions"], f["path"]))
    return {
        "generatedAt": now_ms(),
        "files": files,
        "stats": {
            "files": len(source_files),
            "added": additions,
            "removed": deletions,
            "filesChanged": len(files),
        },
    }


# ----------------------------------------------------------------------
# 方案文档差异
# ----------------------------------------------------------------------

def markdown_sections(text: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    heading = "前言"
    level = 0
    buffer: list[str] = []
    in_fence = False

    def flush() -> None:
        nonlocal buffer
        body = "\n".join(buffer).strip()
        if body or level > 0:
            sections.append({"key": f"{level}::{heading}", "heading": heading, "level": level, "text": body})
        buffer = []

    for line in (text or "").replace("\r\n", "\n").split("\n"):
        if line.strip().startswith("```"):
            in_fence = not in_fence
        match = None if in_fence else re.match(r"^(#{1,6})\s+(.*)$", line)
        if match:
            flush()
            level = len(match.group(1))
            heading = match.group(2).strip()
        else:
            buffer.append(line)
    flush()
    return [s for s in sections if s["heading"] != "前言" or s["text"]]


def plan_diff(old_text: str, new_text: str) -> dict[str, Any]:
    old_sections = markdown_sections(old_text)
    new_sections = markdown_sections(new_text)
    old_map = {s["key"]: s for s in old_sections}
    new_map = {s["key"]: s for s in new_sections}

    sections: list[dict[str, Any]] = []
    for section in new_sections:
        before = old_map.get(section["key"])
        if not before:
            sections.append({**section, "status": "added", "newText": section["text"]})
        elif before["text"].strip() != section["text"].strip():
            sections.append({**section, "status": "modified", "oldText": before["text"], "newText": section["text"]})
        else:
            sections.append({**section, "status": "unchanged", "oldText": before["text"], "newText": section["text"]})
    for section in old_sections:
        if section["key"] not in new_map:
            sections.append({**section, "status": "removed", "oldText": section["text"]})

    patch, additions, deletions = _patch_for(old_text or "", new_text or "", "PLAN.md")
    return {
        "unified": patch,
        "sections": sections,
        "additions": additions,
        "deletions": deletions,
    }


# ----------------------------------------------------------------------
# 文件树
# ----------------------------------------------------------------------

def build_tree(root: Path, statuses: dict[str, str] | None = None) -> dict[str, Any] | None:
    statuses = statuses or {}
    if not root.exists():
        return None

    def node_for(path: Path, rel: str, depth: int) -> dict[str, Any]:
        if path.is_dir():
            children: list[dict[str, Any]] = []
            if depth < 12:
                try:
                    entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
                except OSError:
                    entries = []
                for entry in entries:
                    if entry.name in {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}:
                        continue
                    child_rel = f"{rel}/{entry.name}" if rel else entry.name
                    children.append(node_for(entry, child_rel, depth + 1))
            return {
                "name": path.name or root.name,
                "path": rel,
                "type": "dir",
                "children": children,
            }
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        return {
            "name": path.name,
            "path": rel,
            "type": "file",
            "size": size,
            "status": statuses.get(rel, "unchanged"),
        }

    return node_for(root, "", 0)


def status_map(files: list[dict[str, Any]]) -> dict[str, str]:
    return {f["path"]: f["status"] for f in files}
