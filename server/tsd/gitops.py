from __future__ import annotations

"""Git 集成：仓库检索、克隆、本地/远程对比、提交与推送。

约定：
- 项目的 source/ 目录就是 git 工作区（克隆时保留 .git），升级结果在 v<version>/ 目录；
- 差异计算会跳过 .git，因此两者可以共存；
- 发布时只把差异涉及的文件同步进工作区，避免误删仓库里未被升级涉及的内容。
"""

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .config import SettingsStore
from .diffing import compute_diffs
from .store import ProjectStore
from .utils import copy_tree, detect_version, now_ms, walk_files

GIT_TIMEOUT = 120
CLONE_TIMEOUT = 600


class GitError(RuntimeError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def git_available() -> bool:
    return shutil.which("git") is not None


def looks_like_repo(directory: Path) -> bool:
    """识别工作区仓库（.git 目录）与裸仓库（HEAD + objects + refs）。"""
    if (directory / ".git").exists():
        return True
    return (
        (directory / "HEAD").exists()
        and (directory / "objects").is_dir()
        and (directory / "refs").is_dir()
    )


def _run(
    args: list[str],
    cwd: Path | None = None,
    timeout: int = GIT_TIMEOUT,
    extra_env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "echo",
        "LC_ALL": "C",
        **(extra_env or {}),
    }
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as exc:
        raise GitError("未检测到 git 命令，请先安装 Git 并加入 PATH", 500) from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git 命令超时：{' '.join(args[:3])}", 504) from exc
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _git(args: list[str], cwd: Path, timeout: int = GIT_TIMEOUT, check: bool = False) -> str:
    code, out, err = _run(["git", *args], cwd, timeout)
    if check and code != 0:
        raise GitError((err or out or f"git {' '.join(args)} 失败")[:500], 500)
    return out if code == 0 else ""


class GitOps:
    def __init__(self, store: ProjectStore, settings: SettingsStore) -> None:
        self.store = store
        self.settings = settings

    # ------------------------------------------------------------------
    # 仓库检索
    # ------------------------------------------------------------------
    async def search_repos(self, prefix: str) -> dict[str, Any]:
        cfg = self.settings.git()
        provider = (cfg.get("provider") or "local").strip().lower()
        prefix = (prefix or "").strip()
        repos: list[dict[str, Any]] = []
        note = ""

        if provider in {"gitlab", "github", "generic"} and (cfg.get("baseUrl") or "").strip():
            try:
                repos = await self._remote_repos(provider, cfg, prefix)
            except Exception as exc:  # noqa: BLE001
                note = f"远程仓库查询失败：{exc}（已回退到本地扫描）"

        local = self._local_repos(cfg, prefix)
        seen = {repo["name"] for repo in repos}
        for repo in local:
            if repo["name"] not in seen:
                repos.append(repo)
                seen.add(repo["name"])

        if not repos and not note:
            note = (
                "没有匹配的仓库。可以：1) 在设置里配置 Git 服务地址与访问令牌；"
                "2) 把仓库放进本地扫描目录；3) 直接填写仓库 URL。"
            )
        return {"provider": provider, "prefix": prefix, "repos": repos[:80], "note": note}

    def _local_repos(self, cfg: dict[str, Any], prefix: str) -> list[dict[str, Any]]:
        root_value = (cfg.get("reposRoot") or "").strip()
        root = Path(root_value).expanduser() if root_value else (self.store.workspace / "repos")
        if not root.exists():
            return []
        repos: list[dict[str, Any]] = []
        try:
            entries = sorted(root.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            return []
        for entry in entries:
            if not entry.is_dir():
                continue
            name = entry.name
            if prefix and not name.lower().startswith(prefix.lower()):
                continue
            # 裸仓库（mirror / 服务端仓库）没有 .git 子目录，也要按仓库处理
            is_repo = looks_like_repo(entry)
            bare = is_repo and not (entry / ".git").exists()
            branch = ""
            if is_repo:
                if bare:
                    branch = _git(["symbolic-ref", "--short", "HEAD"], entry) or ""
                else:
                    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], entry) or ""
            repos.append(
                {
                    "name": name,
                    "fullName": name,
                    "url": str(entry),
                    "path": str(entry),
                    "description": "本地仓库" if is_repo else "本地目录（非 Git 仓库）",
                    "defaultBranch": branch or cfg.get("defaultBranch") or "main",
                    "updatedAt": int(entry.stat().st_mtime * 1000),
                    "provider": "local",
                }
            )
        return repos

    async def _remote_repos(
        self, provider: str, cfg: dict[str, Any], prefix: str
    ) -> list[dict[str, Any]]:
        base = (cfg.get("baseUrl") or "").strip().rstrip("/")
        token = (cfg.get("token") or "").strip()
        headers = {"Accept": "application/json"}

        if provider == "gitlab":
            url = f"{base}/api/v4/projects"
            params = {"search": prefix, "per_page": "50", "simple": "true", "order_by": "last_activity_at"}
            if token:
                headers["PRIVATE-TOKEN"] = token
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()
            items = payload if isinstance(payload, list) else []
            return [
                {
                    "name": str(item.get("path") or item.get("name") or ""),
                    "fullName": str(item.get("path_with_namespace") or item.get("name") or ""),
                    "url": str(item.get("http_url_to_repo") or item.get("ssh_url_to_repo") or ""),
                    "description": str(item.get("description") or ""),
                    "defaultBranch": str(item.get("default_branch") or cfg.get("defaultBranch") or "main"),
                    "updatedAt": _iso_to_ms(item.get("last_activity_at")),
                    "provider": "gitlab",
                }
                for item in items
                if isinstance(item, dict)
            ]

        if provider == "github":
            api_base = base or "https://api.github.com"
            if token:
                headers["Authorization"] = f"Bearer {token}"
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{api_base}/search/repositories",
                    params={"q": f"{prefix} in:name", "per_page": "50"},
                    headers=headers,
                )
            response.raise_for_status()
            payload = response.json()
            items = payload.get("items") if isinstance(payload, dict) else []
            return [
                {
                    "name": str(item.get("name") or ""),
                    "fullName": str(item.get("full_name") or ""),
                    "url": str(item.get("clone_url") or item.get("html_url") or ""),
                    "description": str(item.get("description") or ""),
                    "defaultBranch": str(item.get("default_branch") or "main"),
                    "updatedAt": _iso_to_ms(item.get("updated_at")),
                    "provider": "github",
                }
                for item in (items or [])
                if isinstance(item, dict)
            ]

        # generic REST
        path = (cfg.get("reposPath") or "").strip() or "/api/repos"
        url = base + path
        if token:
            headers["Authorization"] = f"Bearer {token}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, params={"search": prefix, "prefix": prefix}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        items: Any = payload
        if isinstance(payload, dict):
            items = payload.get("items") or payload.get("data") or payload.get("repos") or []
        repos: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("path") or "")
            if prefix and not name.lower().startswith(prefix.lower()):
                continue
            repos.append(
                {
                    "name": name,
                    "fullName": str(item.get("fullName") or item.get("full_name") or name),
                    "url": str(item.get("url") or item.get("cloneUrl") or item.get("clone_url") or ""),
                    "description": str(item.get("description") or ""),
                    "defaultBranch": str(item.get("defaultBranch") or item.get("default_branch") or "main"),
                    "updatedAt": _iso_to_ms(item.get("updatedAt") or item.get("updated_at")),
                    "provider": "generic",
                }
            )
        return repos

    # ------------------------------------------------------------------
    # 克隆
    # ------------------------------------------------------------------
    def clone(self, project: dict[str, Any], url: str, branch: str | None = None) -> dict[str, Any]:
        url = (url or "").strip()
        if not url:
            raise GitError("缺少仓库地址", 400)
        if not git_available():
            raise GitError("未检测到 git 命令，请先安装 Git 并加入 PATH", 500)

        paths = self.store.paths(project["id"])
        source_dir = paths["source"]
        if (source_dir / ".git").exists():
            raise GitError("该项目的代码目录已经是 Git 工作区，无需重复克隆", 409)

        if source_dir.exists():
            shutil.rmtree(source_dir, ignore_errors=True)
        source_dir.parent.mkdir(parents=True, exist_ok=True)

        local_path = Path(url).expanduser()
        if local_path.exists() and local_path.is_dir():
            if looks_like_repo(local_path):
                # 工作区仓库与裸仓库都走 git clone，保留历史与 origin 远程
                self._clone_local_repo(local_path, source_dir)
            else:
                copy_tree(local_path, source_dir)
                self._init_local_repo(source_dir)
        else:
            self._clone_remote(url, source_dir, branch)

        detected = detect_version(source_dir)
        project["sourceUrl"] = url
        project["sourceKind"] = "git"
        if detected:
            project["baseVersion"] = detected
        self.store.save(project)

        branch_name = _git(["rev-parse", "--abbrev-ref", "HEAD"], source_dir) or (branch or "")
        return {
            "ok": True,
            "branch": branch_name,
            "remote": _git(["remote", "get-url", "origin"], source_dir),
            "files": sum(1 for _ in walk_files(source_dir)),
            "baseVersion": detected or project.get("baseVersion"),
        }

    def _clone_local_repo(self, source: Path, dest: Path) -> None:
        dest.mkdir(parents=True, exist_ok=True)
        code, _out, err = _run(["git", "clone", "--quiet", str(source), str(dest)], dest.parent, CLONE_TIMEOUT)
        if code != 0:
            raise GitError(f"克隆本地仓库失败：{err[-300:]}", 500)

    def _clone_remote(self, url: str, dest: Path, branch: str | None) -> None:
        args = ["git"]
        token = (self.settings.git().get("token") or "").strip()
        if token and url.startswith("https://"):
            args += ["-c", f"http.extraheader=Authorization: Bearer {token}"]
        args += ["clone", "--quiet", "--depth", "50"]
        if branch:
            args += ["--branch", branch]
        args += [url, str(dest)]
        dest.parent.mkdir(parents=True, exist_ok=True)
        code, _out, err = _run(args, dest.parent, CLONE_TIMEOUT)
        if code != 0:
            hint = "（私有仓库请先在设置中配置 Git 访问令牌）" if "Authentication" in err or "403" in err else ""
            raise GitError(f"克隆失败：{err[-400:]}{hint}", 502)

    def _init_local_repo(self, directory: Path) -> None:
        cfg = self.settings.git()
        branch = cfg.get("defaultBranch") or "main"
        _run(["git", "init", "-b", branch], directory)
        _run(["git", "add", "-A"], directory)
        _run(
            [
                "git",
                "-c",
                f"user.name={cfg.get('authorName') or 'TSD Agent'}",
                "-c",
                f"user.email={cfg.get('authorEmail') or 'tsd-agent@localhost'}",
                "commit",
                "--quiet",
                "-m",
                "chore: import local sources",
            ],
            directory,
        )

    # ------------------------------------------------------------------
    # 状态 / 分支 / 对比
    # ------------------------------------------------------------------
    def _repo_dir(self, project: dict[str, Any]) -> Path:
        repo = self.store.paths(project["id"])["source"]
        if not (repo / ".git").exists():
            raise GitError("该项目还不是 Git 仓库，请先克隆远程仓库", 409)
        return repo

    def status(self, project: dict[str, Any]) -> dict[str, Any]:
        repo = self.store.paths(project["id"])["source"]
        if not (repo / ".git").exists():
            return {
                "initialized": False,
                "repoDir": str(repo),
                "gitAvailable": git_available(),
                "sourceUrl": project.get("sourceUrl") or "",
            }

        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], repo)
        remote_url = _git(["remote", "get-url", "origin"], repo)
        upstream = _git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo)
        ahead = behind = 0
        if upstream:
            counts = _git(["rev-list", "--left-right", "--count", f"{upstream}...HEAD"], repo)
            parts = counts.split()
            if len(parts) == 2:
                behind, ahead = int(parts[0]), int(parts[1])

        dirty: list[dict[str, str]] = []
        porcelain = _git(["status", "--porcelain=v1"], repo)
        for line in porcelain.splitlines():
            if len(line) < 4:
                continue
            code = line[:2].strip() or "?"
            path = line[3:].strip().strip('"')
            dirty.append({"path": path, "status": _porcelain_status(code)})

        last_commit = None
        log_line = _git(["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI"], repo)
        if log_line:
            parts = log_line.split("")
            if len(parts) == 4:
                last_commit = {"sha": parts[0], "message": parts[1], "author": parts[2], "date": parts[3]}

        remotes = []
        for line in _git(["remote", "-v"], repo).splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[0] not in {item["name"] for item in remotes}:
                remotes.append({"name": fields[0], "url": fields[1]})

        return {
            "initialized": True,
            "repoDir": str(repo),
            "gitAvailable": True,
            "branch": branch,
            "upstream": upstream,
            "remoteUrl": remote_url,
            "remotes": remotes,
            "ahead": ahead,
            "behind": behind,
            "dirty": dirty,
            "lastCommit": last_commit,
            "sourceUrl": project.get("sourceUrl") or "",
        }

    def branches(self, project: dict[str, Any]) -> dict[str, Any]:
        repo = self._repo_dir(project)
        current = _git(["rev-parse", "--abbrev-ref", "HEAD"], repo)

        def parse(ref: str) -> list[dict[str, str]]:
            output = _git(["for-each-ref", "--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:iso8601)%1f%(subject)", ref], repo)
            items: list[dict[str, str]] = []
            for line in output.splitlines():
                parts = line.split("")
                if len(parts) >= 4:
                    items.append({"name": parts[0], "sha": parts[1], "date": parts[2], "subject": parts[3]})
            return items

        return {
            "current": current,
            "local": parse("refs/heads"),
            "remote": parse("refs/remotes"),
        }

    def compare(self, project: dict[str, Any], base: str | None = None) -> dict[str, Any]:
        repo = self._repo_dir(project)
        cfg = self.settings.git()
        fetched = False
        if _git(["remote"], repo):
            code, _out, _err = _run(["git", "fetch", "--all", "--prune", "--quiet"], repo, 90)
            fetched = code == 0

        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], repo)
        candidates = [
            base,
            "@{u}",
            f"origin/{branch}" if branch and branch != "HEAD" else None,
            f"origin/{cfg.get('defaultBranch') or 'main'}",
            "origin/HEAD",
            "HEAD~0",
        ]
        resolved = ""
        for candidate in candidates:
            if not candidate:
                continue
            if _git(["rev-parse", "--verify", "--quiet", candidate], repo):
                resolved = candidate
                break

        if not resolved:
            return {
                "ok": False,
                "reason": "no-base",
                "branch": branch,
                "note": "没有可对比的远程分支，请先 git fetch 或配置默认分支",
                "fetched": fetched,
            }

        counts = _git(["rev-list", "--left-right", "--count", f"{resolved}...HEAD"], repo).split()
        behind, ahead = (int(counts[0]), int(counts[1])) if len(counts) == 2 else (0, 0)

        def commits(spec: str) -> list[dict[str, str]]:
            output = _git(["log", "--oneline", "--no-decorate", "--max-count=30", spec], repo)
            items: list[dict[str, str]] = []
            for line in output.splitlines():
                sha, _, subject = line.partition(" ")
                items.append({"sha": sha, "subject": subject})
            return items

        files: list[dict[str, str]] = []
        for line in _git(["diff", "--name-status", f"{resolved}...HEAD"], repo).splitlines():
            parts = line.split("	")
            if len(parts) >= 2:
                files.append({"status": _name_status(parts[0]), "path": parts[-1]})

        return {
            "ok": True,
            "base": resolved,
            "branch": branch,
            "fetched": fetched,
            "ahead": ahead,
            "behind": behind,
            "commits": commits(f"{resolved}..HEAD"),
            "incoming": commits(f"HEAD..{resolved}"),
            "files": files,
        }

    # ------------------------------------------------------------------
    # 提交与推送
    # ------------------------------------------------------------------
    def publish(
        self,
        project: dict[str, Any],
        message: str,
        branch: str,
        push: bool = True,
        remote: str = "origin",
        create_branch: bool = True,
        force: bool = False,
    ) -> dict[str, Any]:
        repo = self._repo_dir(project)
        target = self.store.target_dir(project)
        if not target.exists():
            raise GitError("还没有升级结果，请先执行一次升级", 409)
        branch = (branch or "").strip() or f"upgrade/v{project.get('targetVersion') or 'next'}"
        message = (message or "").strip() or f"feat: upgrade to v{project.get('targetVersion') or 'next'}"

        dirty = [line[3:].strip() for line in _git(["status", "--porcelain=v1"], repo).splitlines() if len(line) > 3]
        if dirty and not force:
            return {
                "ok": False,
                "reason": "worktree-dirty",
                "branch": branch,
                "dirty": dirty[:50],
                "note": "工作区有未提交改动；确认覆盖请再次提交并勾选强制覆盖",
            }

        # 分支：新建或切换
        if create_branch:
            _git(["checkout", "-B", branch], repo, check=True)
        elif _git(["rev-parse", "--verify", "--quiet", branch], repo):
            _git(["checkout", branch], repo, check=True)
        else:
            _git(["checkout", "-b", branch], repo, check=True)

        # 只同步差异涉及的文件，避免误删仓库中未参与升级的内容
        source_dir = self.store.paths(project["id"])["source"]
        file_diff = compute_diffs(source_dir, target)
        changed: list[dict[str, str]] = []
        for entry in file_diff["files"]:
            rel = entry["path"]
            status = entry["status"]
            try:
                if status == "deleted":
                    victim = repo / rel
                    if victim.exists():
                        victim.unlink()
                    changed.append({"path": rel, "status": "deleted"})
                else:
                    src = target / rel
                    if not src.exists():
                        continue
                    dst = repo / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
                    changed.append({"path": rel, "status": status})
            except OSError as exc:
                raise GitError(f"同步文件失败：{rel}（{exc}）", 500) from exc

        _git(["add", "-A"], repo, check=True)
        staged = _git(["status", "--porcelain=v1"], repo)
        if not staged.strip():
            return {
                "ok": False,
                "reason": "no-changes",
                "branch": branch,
                "files": changed,
                "note": "升级结果与当前分支内容一致，没有需要提交的改动",
            }

        cfg = self.settings.git()
        commit_args = [
            "git",
            "-c",
            f"user.name={cfg.get('authorName') or 'TSD Agent'}",
            "-c",
            f"user.email={cfg.get('authorEmail') or 'tsd-agent@localhost'}",
            "commit",
            "--quiet",
            "-m",
            message,
        ]
        code, out, err = _run(commit_args, repo)
        if code != 0:
            raise GitError(f"提交失败：{err[-400:] or out[-400:]}", 500)
        sha = _git(["rev-parse", "--short", "HEAD"], repo)

        result: dict[str, Any] = {
            "ok": True,
            "branch": branch,
            "sha": sha,
            "files": changed,
            "pushed": False,
            "remote": remote,
            "note": "",
        }

        if push:
            push_args = ["git"]
            token = (cfg.get("token") or "").strip()
            remote_url = _git(["remote", "get-url", remote], repo)
            if token and remote_url.startswith("https://"):
                push_args += ["-c", f"http.extraheader=Authorization: Bearer {token}"]
            push_args += ["push", "-u", remote, branch]
            code, out, err = _run(push_args, repo, 300)
            if code != 0:
                result.update(
                    {
                        "ok": False,
                        "reason": "push-failed",
                        "pushed": False,
                        "error": (err or out)[-600:],
                        "note": "提交已在本地完成，推送失败；可配置访问令牌后重试推送",
                    }
                )
                return result
            result["pushed"] = True
            url = _web_url(remote_url, branch)
            if url:
                result["url"] = url
        return result

    def push(self, project: dict[str, Any], branch: str, remote: str = "origin") -> dict[str, Any]:
        repo = self._repo_dir(project)
        cfg = self.settings.git()
        args = ["git"]
        token = (cfg.get("token") or "").strip()
        remote_url = _git(["remote", "get-url", remote], repo)
        if token and remote_url.startswith("https://"):
            args += ["-c", f"http.extraheader=Authorization: Bearer {token}"]
        args += ["push", "-u", remote, branch]
        code, out, err = _run(args, repo, 300)
        if code != 0:
            raise GitError(f"推送失败：{(err or out)[-500:]}", 502)
        return {"ok": True, "branch": branch, "remote": remote, "url": _web_url(remote_url, branch)}


def _porcelain_status(code: str) -> str:
    if code.startswith("?"):
        return "untracked"
    if "D" in code:
        return "deleted"
    if "R" in code:
        return "renamed"
    if "A" in code:
        return "added"
    return "modified"


def _name_status(code: str) -> str:
    if code.startswith("A"):
        return "added"
    if code.startswith("D"):
        return "deleted"
    if code.startswith("R"):
        return "renamed"
    return "modified"


def _iso_to_ms(value: Any) -> int:
    if not value:
        return 0
    text = str(value)
    try:
        from datetime import datetime

        normalized = text.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except Exception:
        return 0


def _web_url(remote_url: str, branch: str) -> str:
    url = (remote_url or "").strip()
    if not url:
        return ""
    if url.endswith(".git"):
        url = url[:-4]
    if url.startswith("git@"):
        host, _, path = url.partition(":")
        url = f"https://{host.replace('git@', '')}/{path}"
    if url.startswith("http"):
        return f"{url}/-/tree/{quote(branch)}" if "/-/" not in url and "gitlab" in url else f"{url}/tree/{quote(branch)}"
    return ""


def _now() -> int:
    return now_ms()
