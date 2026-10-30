from __future__ import annotations

import asyncio
import io
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

import httpx

from .utils import copy_tree, detect_version, read_text

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 TSD-Agent/1.0"
)

LogFn = Callable[[str, str], None]

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


def use_env_proxy(url: str) -> bool:
    """本机地址不走代理（避免企业代理 / socks 环境把 localhost 也代理掉）。"""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return True
    if host in LOOPBACK_HOSTS or host.endswith(".local"):
        return False
    return True


async def fetch_text(url: str, timeout: float = 30.0, max_bytes: int = 6_000_000) -> tuple[str, str, str]:
    """抓取 URL，返回 (文本, content_type, 最终 URL)。"""
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"}
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=timeout, headers=headers, trust_env=use_env_proxy(url)
    ) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    break
            raw = b"".join(chunks)
            encoding = response.encoding or "utf-8"
        try:
            text = raw.decode(encoding, "replace")
        except LookupError:
            text = raw.decode("utf-8", "replace")
        return text, content_type, str(response.url)


# ----------------------------------------------------------------------
# HTML → Markdown（无外部依赖，保留标题层级 / 列表 / 代码块 / 表格）
# ----------------------------------------------------------------------

def _clean_text(value: str) -> str:
    value = value.replace("\u00a0", " ").replace("\u200b", "")
    return re.sub(r"[ \t]{2,}", " ", value).strip()


def html_to_markdown(html: str, source_url: str = "") -> str:
    try:
        from bs4 import BeautifulSoup, NavigableString, Tag
    except Exception:
        text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
        text = re.sub(r"(?s)<[^>]+>", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return _clean_text(text)

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "iframe", "svg", "form", "button", "nav", "footer", "aside"]):
        tag.decompose()

    title = _clean_text(soup.title.get_text(" ", strip=True)) if soup.title else ""

    root = None
    for selector in ("main", "article", '[role="main"]'):
        found = soup.select_one(selector)
        if found and len(found.get_text(strip=True)) > 200:
            root = found
            break
    if root is None:
        for candidate in soup.find_all("div"):
            classes = " ".join(candidate.get("class", []))
            if re.search(r"(content|article|markdown|doc|main)", classes, re.I) and len(candidate.get_text(strip=True)) > 400:
                root = candidate
                break
    if root is None:
        root = soup.body or soup

    lines: list[str] = []
    if title:
        lines.append(f"# {title}\n")

    def inline(node: Any) -> str:
        out: list[str] = []
        for child in getattr(node, "children", []):
            if isinstance(child, NavigableString):
                out.append(str(child))
                continue
            if not isinstance(child, Tag):
                continue
            name = child.name
            if name in ("strong", "b"):
                inner = inline(child).strip()
                out.append(f"**{inner}**" if inner else "")
            elif name in ("em", "i"):
                inner = inline(child).strip()
                out.append(f"*{inner}*" if inner else "")
            elif name == "code":
                inner = child.get_text(" ", strip=True)
                out.append(f"`{inner}`" if inner else "")
            elif name == "a":
                href = child.get("href", "")
                label = inline(child).strip() or _clean_text(child.get_text())
                if href and not href.startswith(("#", "javascript:")):
                    out.append(f"[{label}]({urljoin(source_url, href)})" if label else "")
                else:
                    out.append(label)
            elif name == "br":
                out.append("\n")
            elif name == "img":
                alt = child.get("alt", "")
                src = child.get("src", "")
                if src:
                    out.append(f"![{alt}]({urljoin(source_url, src)})")
            else:
                out.append(inline(child))
        return "".join(out)

    def walk(node: Any, depth: int = 0) -> None:
        for child in getattr(node, "children", []):
            if not isinstance(child, Tag):
                continue
            name = child.name
            if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                text = _clean_text(inline(child)) or _clean_text(child.get_text(" ", strip=True))
                if text:
                    lines.append(f"{'#' * int(name[1])} {text}\n")
            elif name == "p":
                text = _clean_text(inline(child))
                if text:
                    lines.append(f"{text}\n")
            elif name in ("ul", "ol"):
                ordered = name == "ol"
                index = 1
                for li in child.find_all("li", recursive=False):
                    text = _clean_text(inline(li))
                    if not text:
                        continue
                    prefix = f"{index}. " if ordered else "- "
                    lines.append("  " * depth + prefix + text)
                    index += 1
                lines.append("")
            elif name == "pre":
                code = child.get_text("\n").strip("\n")
                classes = " ".join(child.get("class", []))
                match = re.search(r"(?:language|lang)-([\w+-]+)", classes)
                lang = match.group(1) if match else ""
                if code:
                    lines.append(f"```{lang}\n{code}\n```\n")
            elif name == "blockquote":
                text = _clean_text(inline(child))
                if text:
                    lines.append("\n".join("> " + line for line in text.splitlines()) + "\n")
            elif name == "table":
                rows = child.find_all("tr")
                if rows:
                    header_cells = [_clean_text(c.get_text(" ", strip=True)) for c in rows[0].find_all(["th", "td"])]
                    if header_cells:
                        lines.append("| " + " | ".join(header_cells) + " |")
                        lines.append("| " + " | ".join("---" for _ in header_cells) + " |")
                        for row in rows[1:]:
                            cells = [_clean_text(c.get_text(" ", strip=True)) for c in row.find_all(["td", "th"])]
                            if cells:
                                lines.append("| " + " | ".join(cells) + " |")
                        lines.append("")
            elif name == "hr":
                lines.append("---\n")
            elif name in ("div", "section", "article", "main", "body", "span", "figure", "details", "summary"):
                walk(child, depth)
            else:
                text = _clean_text(inline(child))
                if text:
                    lines.append(f"{text}\n")

    walk(root)

    markdown = "\n".join(lines)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()
    if len(markdown) < 40:
        markdown = _clean_text(soup.get_text("\n", strip=True))
    return markdown


def discover_code_links(html: str, base_url: str) -> list[str]:
    """从方案页面中寻找可用的代码来源（GitHub / Gitee / zip）。"""
    candidates: list[str] = []
    for match in re.finditer(r'href=["\']([^"\']+)["\']', html, re.I):
        href = match.group(1)
        if not href or href.startswith(("#", "mailto:", "javascript:")):
            continue
        absolute = urljoin(base_url, href)
        if re.search(r"(github\.com/[^/]+/[^/]+|gitlab\.com/[^/]+/[^/]+|gitee\.com/[^/]+/[^/]+|\.zip(\?|$)|/archive/)", absolute, re.I):
            if absolute not in candidates:
                candidates.append(absolute)
    for match in re.finditer(r"https?://[^\s<>\"']+(?:\.zip|/archive/[^\s<>\"']+)", html, re.I):
        if match.group(0) not in candidates:
            candidates.append(match.group(0))
    return candidates[:6]


# ----------------------------------------------------------------------
# 下载 / 克隆 / 复制代码
# ----------------------------------------------------------------------

def _github_zip_candidates(url: str) -> list[str]:
    match = re.search(r"github\.com/([^/]+)/([^/#?]+)", url, re.I)
    if not match:
        return []
    owner = match.group(1)
    repo = re.sub(r"\.git$", "", match.group(2))
    return [
        f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/main",
        f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/master",
        f"https://codeload.github.com/{owner}/{repo}/zip/HEAD",
    ]


def _extract_zip(data: bytes, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = [m for m in archive.infolist() if not m.is_dir()]
        roots = {m.filename.split("/")[0] for m in members if "/" in m.filename}
        strip_root = roots.pop() if len(roots) == 1 else None
        for member in members:
            name = member.filename
            if strip_root and name.startswith(strip_root + "/"):
                name = name[len(strip_root) + 1 :]
            if not name or name.startswith("__MACOSX") or "/__MACOSX/" in name:
                continue
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest.resolve())):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(member) as source, target.open("wb") as sink:
                    shutil.copyfileobj(source, sink)
                count += 1
            except Exception:
                continue
    return count


async def _download_zip(url: str, dest: Path) -> int:
    headers = {"User-Agent": UA}
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=120.0, headers=headers, trust_env=use_env_proxy(url)
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        data = response.content
    return _extract_zip(data, dest)


async def _git_clone(url: str, dest: Path) -> tuple[bool, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            "git",
            "clone",
            "--depth",
            "1",
            "--single-branch",
            url,
            str(dest),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
        if process.returncode == 0:
            return True, "git clone 成功"
        return False, stderr.decode("utf-8", "replace")[-400:]
    except FileNotFoundError:
        return False, "系统未安装 git"
    except asyncio.TimeoutError:
        return False, "git clone 超时"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:300]


async def download_source(kind: str, url: str, dest: Path, log: LogFn) -> dict[str, Any]:
    """把代码放到 dest，返回 {ok, method, files, note}。"""
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)

    if not url:
        log("未提供代码地址，跳过下载", "warn")
        return {"ok": False, "method": "none", "files": 0, "note": "缺少代码地址"}

    if kind == "local":
        source = Path(url).expanduser()
        if not source.exists() or not source.is_dir():
            return {"ok": False, "method": "local", "files": 0, "note": f"目录不存在：{source}"}
        log(f"复制本地目录 {source}")
        count = copy_tree(source, dest)
        return {"ok": True, "method": "local", "files": count, "note": f"已复制 {count} 个文件"}

    if not re.match(r"^https?://", url, re.I):
        return {"ok": False, "method": "none", "files": 0, "note": "无效的代码地址"}

    is_git = kind == "git" or bool(re.search(r"(github|gitlab|gitee|bitbucket)\.(com|org)/", url, re.I))
    is_zip = kind == "zip" or url.lower().endswith(".zip") or "/archive/" in url

    if is_git and not is_zip:
        log("尝试 git clone（浅克隆）…")
        ok, note = await _git_clone(url, dest)
        if ok:
            files = sum(1 for _ in dest.rglob("*") if _.is_file())
            return {"ok": True, "method": "git", "files": files, "note": note}
        log(f"git clone 失败：{note}", "warn")

    if is_zip or is_git:
        urls = [url] if is_zip else _github_zip_candidates(url) or [url]
        for candidate in urls:
            try:
                log(f"下载压缩包 {candidate}")
                count = await _download_zip(candidate, dest)
                if count:
                    return {"ok": True, "method": "zip", "files": count, "note": f"解压 {count} 个文件"}
            except Exception as exc:  # noqa: BLE001
                log(f"压缩包下载失败：{exc}", "warn")

    return {"ok": False, "method": "none", "files": 0, "note": "无法获取代码，已创建占位目录"}


def scaffold_source(dest: Path, project_name: str, plan_text: str, source_url: str) -> None:
    """无代码来源时创建一个最小可用脚手架，保证后续流程可跑通。"""
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "README.md").write_text(
        f"# {project_name}\n\n> 由 TSD Agent 基于方案页面生成的项目骨架。\n\n"
        f"- 方案来源：{source_url or '本地输入'}\n"
        f"- 生成时间：{__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
        "## 说明\n\n原始代码未能自动获取，以下内容来自方案文档。\n\n"
        + "\n".join(f"> {line}" for line in plan_text.strip().splitlines()[:40]),
        "utf-8",
    )
    (dest / "src").mkdir(exist_ok=True)
    (dest / "src" / "main.py").write_text(
        '"""项目入口（占位）。"""\n\n\ndef main() -> None:\n    print("Hello from '
        + project_name
        + '")\n\n\nif __name__ == "__main__":\n    main()\n',
        "utf-8",
    )
    (dest / "requirements.txt").write_text("# 依赖清单\n", "utf-8")


def read_plan_from_source(source: Path) -> str:
    """从代码仓库中提炼一份初始方案（README 优先）。"""
    for name in ("README.md", "readme.md", "README.txt", "README.rst", "docs/README.md"):
        candidate = source / name
        if candidate.exists():
            text, _ = read_text(candidate, 200_000)
            if text.strip():
                return text
    sections = ["# 项目现状说明\n", "> 未能从代码库中找到 README，以下为自动扫描结果。\n"]
    count = 0
    for path in source.rglob("*"):
        if path.is_file():
            count += 1
        if count > 400:
            break
    sections.append(f"\n- 文件总数（前 400 个扫描）：{count}\n")
    sections.append(f"- 探测版本：{detect_version(source) or '未知'}\n")
    return "\n".join(sections)
