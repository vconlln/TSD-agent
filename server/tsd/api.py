from __future__ import annotations

import asyncio
import json
import time
import zipfile
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .agent_edit import InlineAgent, InlineAgentError
from .auth import W3Auth, W3AuthError
from .chat import ChatAgent
from .config import SettingsStore
from .diffing import build_tree, compute_diffs, plan_diff, status_map
from .events import EventHub
from .gitops import GitError, GitOps
from .pipeline import UpgradePipeline
from .store import ProjectStore
from .utils import has_binary_ext, is_binary, now_ms, read_text, safe_join, walk_files


class CreateProjectBody(BaseModel):
    name: str
    sourceUrl: str | None = None
    sourceKind: str | None = "page"
    targetVersion: str | None = None
    description: str | None = None


class RunBody(BaseModel):
    upgradeRequest: str = Field(default="")
    targetVersion: str | None = None
    referenceUrl: str | None = None


class ChatBody(BaseModel):
    message: str
    conversationId: str | None = None


class ApplyBody(BaseModel):
    proposalId: str


class W3LoginBody(BaseModel):
    username: str
    password: str


class GitCloneBody(BaseModel):
    url: str
    branch: str | None = None


class GitPublishBody(BaseModel):
    message: str = ""
    branch: str | None = None
    push: bool = True
    remote: str = "origin"
    createBranch: bool = True
    force: bool = False


class GitPushBody(BaseModel):
    branch: str
    remote: str = "origin"


class AgentEditBody(BaseModel):
    path: str
    instruction: str
    startLine: int = 0
    endLine: int = 0
    content: str | None = None


class AgentExplainBody(BaseModel):
    path: str
    startLine: int = 0
    endLine: int = 0
    content: str | None = None
    question: str | None = None


class FileWriteBody(BaseModel):
    path: str
    content: str
    side: str = "target"


def empty_diff(project_id: str) -> dict[str, Any]:
    return {
        "projectId": project_id,
        "generatedAt": now_ms(),
        "plan": {"unified": "", "sections": [], "additions": 0, "deletions": 0},
        "files": [],
        "stats": {"files": 0, "added": 0, "removed": 0, "filesChanged": 0},
    }


def create_app(workspace: Path) -> FastAPI:
    workspace = workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=True)

    store = ProjectStore(workspace)
    settings = SettingsStore(workspace)
    hub = EventHub(workspace / "runs")
    pipeline = UpgradePipeline(store, settings, hub)
    chat_agent = ChatAgent(store, settings, hub)
    w3_auth = W3Auth(settings)
    git_ops = GitOps(store, settings)
    inline_agent = InlineAgent(store, settings)

    started_at = time.time()
    app = FastAPI(title="TSD Agent Backend", version=__version__)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    tasks: dict[str, asyncio.Task[Any]] = {}
    run_refs: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        engine = settings.engine()
        online = settings.llm_available()
        return {
            "ok": True,
            "version": __version__,
            "engine": "online" if online else "offline",
            "model": engine.get("model") if online else "离线启发式",
            "workspace": str(workspace),
            "uptimeSec": round(time.time() - started_at, 1),
            "platform": __import__("sys").platform,
        }

    @app.get("/api/settings")
    async def get_settings() -> dict[str, Any]:
        return settings.public()

    @app.put("/api/settings")
    async def put_settings(body: dict[str, Any]) -> dict[str, Any]:
        return settings.update(body)

    # ------------------------------------------------------------------
    @app.get("/api/projects")
    async def list_projects() -> dict[str, Any]:
        return {"projects": store.list_projects()}

    @app.post("/api/projects")
    async def create_project(body: CreateProjectBody) -> dict[str, Any]:
        if not body.name.strip():
            raise HTTPException(400, "项目名称不能为空")
        project = store.create(
            body.name,
            body.sourceUrl,
            body.sourceKind or "page",
            body.targetVersion,
            body.description,
        )
        return project

    @app.get("/api/projects/{project_id}")
    async def get_project(project_id: str) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        return project

    @app.patch("/api/projects/{project_id}")
    async def patch_project(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        allowed = {"name", "description", "targetVersion", "baseVersion", "tags", "status"}
        patch = {k: v for k, v in body.items() if k in allowed}
        project = store.update(project_id, patch)
        if not project:
            raise HTTPException(404, "项目不存在")
        return project

    @app.delete("/api/projects/{project_id}")
    async def delete_project(project_id: str) -> JSONResponse:
        store.delete(project_id)
        return JSONResponse({"ok": True})

    # ------------------------------------------------------------------
    @app.post("/api/projects/{project_id}/run")
    async def start_run(project_id: str, body: RunBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        for existing in tasks.values():
            if not existing.done():
                for run in store.list_runs(project_id):
                    if run.get("status") == "running" and run.get("id") in run_refs:
                        raise HTTPException(409, "该项目已有正在执行的任务")
        run = store.create_run(project, "upgrade", body.upgradeRequest)
        run_refs[run["id"]] = run
        channel = hub.create(run["id"])
        channel.log("任务已创建，开始执行升级流水线")
        task = asyncio.create_task(
            pipeline.run(project, run, body.upgradeRequest, body.targetVersion, body.referenceUrl)
        )
        tasks[run["id"]] = task

        def _finalize(t: asyncio.Task[Any], rid: str = run["id"]) -> None:
            tasks.pop(rid, None)
            if t.cancelled():
                return
            error = t.exception()
            if error is not None:
                channel.log(f"任务异常终止：{error}", "error")
                try:
                    channel.emit("run.error", message=str(error)[:400])
                    channel.close()
                except Exception:
                    pass

        task.add_done_callback(_finalize)
        return {"runId": run["id"], "run": run}

    @app.post("/api/projects/{project_id}/chat")
    async def start_chat(project_id: str, body: ChatBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        if not body.message.strip():
            raise HTTPException(400, "消息不能为空")
        run = store.create_run(project, "chat", body.message)
        run_refs[run["id"]] = run
        channel = hub.create(run["id"])
        channel.log("收到对话请求")
        task = asyncio.create_task(chat_agent.run(project, run, body.message))
        tasks[run["id"]] = task
        task.add_done_callback(lambda _t, rid=run["id"]: tasks.pop(rid, None))
        return {"runId": run["id"]}

    @app.get("/api/runs")
    async def list_runs(projectId: str) -> dict[str, Any]:
        return {"runs": store.list_runs(projectId)}

    @app.get("/api/runs/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        run = run_refs.get(run_id) or store.find_run(run_id)
        if not run:
            raise HTTPException(404, "运行记录不存在")
        return {k: v for k, v in run.items() if k != "cancelRequested"}

    @app.post("/api/runs/{run_id}/cancel")
    async def cancel_run(run_id: str) -> dict[str, Any]:
        run = run_refs.get(run_id)
        if not run:
            raise HTTPException(404, "运行记录不存在")
        run["cancelRequested"] = True
        task = tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        return {"ok": True}

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str, request: Request, since: int = 0) -> StreamingResponse:
        channel = hub.get(run_id)
        if channel is None:
            raise HTTPException(404, "事件流不存在")

        async def generator() -> AsyncIterator[bytes]:
            yield b": connected\n\n"
            try:
                async for item in channel.subscribe(since):
                    if await request.is_disconnected():
                        break
                    if item == "heartbeat":
                        yield b": ping\n\n"
                        continue
                    if item is None:
                        yield b"data: [DONE]\n\n"
                        break
                    payload = json.dumps(item, ensure_ascii=False)
                    yield f"data: {payload}\n\n".encode("utf-8")
                    if item.get("type") in ("run.done", "run.error"):
                        yield b"data: [DONE]\n\n"
                        break
            except asyncio.CancelledError:
                return

        return StreamingResponse(
            generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/documents")
    async def documents(project_id: str) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)

        def doc(path: Path) -> dict[str, Any]:
            exists = path.exists()
            content = ""
            updated = 0
            if exists:
                content, _ = read_text(path, 2_000_000)
                updated = int(path.stat().st_mtime * 1000)
            return {"content": content, "path": str(path), "updatedAt": updated, "exists": exists}

        return {"projectId": project_id, "plan": doc(paths["plan"]), "update": doc(paths["update"])}

    @app.get("/api/projects/{project_id}/diff")
    async def project_diff(project_id: str, refresh: int = 0) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        target_dir = store.target_dir(project)

        if paths["diff"].exists() and not refresh:
            try:
                return json.loads(paths["diff"].read_text("utf-8"))
            except Exception:
                pass

        if not target_dir.exists():
            return empty_diff(project_id)

        source_dir = paths["source"]
        plan_text, _ = read_text(paths["plan"], 1_000_000)
        update_text, _ = read_text(paths["update"], 1_000_000)
        file_diffs = compute_diffs(source_dir, target_dir)
        doc_diff = plan_diff(plan_text, update_text)
        payload = {
            "projectId": project_id,
            "generatedAt": now_ms(),
            "plan": doc_diff,
            "files": file_diffs["files"],
            "stats": file_diffs["stats"],
        }
        try:
            paths["diff"].write_text(json.dumps(payload, ensure_ascii=False), "utf-8")
        except Exception:
            pass
        return payload

    @app.get("/api/projects/{project_id}/tree")
    async def project_tree(project_id: str, side: str = "target") -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        root = paths["source"] if side == "source" else store.target_dir(project)
        if not root.exists():
            return {"tree": None, "root": str(root), "exists": False}
        statuses: dict[str, str] = {}
        if side == "target" and paths["diff"].exists():
            try:
                data = json.loads(paths["diff"].read_text("utf-8"))
                statuses = status_map(data.get("files", []))
            except Exception:
                statuses = {}
        return {"tree": build_tree(root, statuses), "root": str(root), "exists": True}

    @app.get("/api/projects/{project_id}/file")
    async def project_file(project_id: str, path: str, side: str = "target") -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        root = paths["source"] if side == "source" else store.target_dir(project)
        try:
            target = safe_join(root, path)
        except ValueError:
            raise HTTPException(400, "非法路径")
        if not target.exists() or not target.is_file():
            raise HTTPException(404, "文件不存在")
        if is_binary(target):
            return {
                "path": path,
                "content": "",
                "size": target.stat().st_size,
                "language": "",
                "binary": True,
            }
        content, truncated = read_text(target)
        return {
            "path": path,
            "content": content,
            "size": target.stat().st_size,
            "language": target.suffix.lstrip("."),
            "truncated": truncated,
            "binary": False,
        }

    # ------------------------------------------------------------------
    @app.post("/api/projects/{project_id}/apply")
    async def apply_proposal(project_id: str, body: ApplyBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        proposals = store.proposals(project_id)
        proposal = proposals.get(body.proposalId)
        if not proposal:
            raise HTTPException(404, "修改建议不存在")
        target_dir = store.target_dir(project)
        target_dir.mkdir(parents=True, exist_ok=True)
        written: list[str] = []
        for edit in proposal.get("edits", []):
            rel = str(edit.get("path") or "").lstrip("./")
            content = edit.get("after")
            if not rel or not isinstance(content, str):
                continue
            try:
                target = safe_join(target_dir, rel)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, "utf-8")
            written.append(rel)
        proposal["applied"] = True
        proposals[body.proposalId] = proposal
        store.save_proposals(project_id, proposals)
        await project_diff(project_id, refresh=1)
        try:
            data = json.loads(store.paths(project_id)["diff"].read_text("utf-8"))
            store.update(
                project_id,
                {
                    "status": "ready",
                    "stats": {
                        "files": data["stats"]["files"],
                        "added": data["stats"]["added"],
                        "removed": data["stats"]["removed"],
                        "sections": len([s for s in data["plan"]["sections"] if s.get("status") != "unchanged"]),
                        "filesChanged": data["stats"]["filesChanged"],
                    },
                },
            )
        except Exception:
            pass
        return {"ok": True, "files": written}

    @app.delete("/api/projects/{project_id}/apply")
    async def discard_proposal(project_id: str, body: ApplyBody) -> dict[str, Any]:
        proposals = store.proposals(project_id)
        proposal = proposals.get(body.proposalId)
        if proposal:
            proposal["discarded"] = True
            proposals[body.proposalId] = proposal
            store.save_proposals(project_id, proposals)
        return {"ok": True}

    @app.post("/api/projects/{project_id}/export")
    async def export_project(project_id: str) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        target_dir = store.target_dir(project)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        archive_path = store.exports_dir / f"{project['slug']}-v{project['targetVersion']}-{stamp}.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            if paths["plan"].exists():
                archive.write(paths["plan"], "plan/PLAN.md")
            if paths["update"].exists():
                archive.write(paths["update"], "plan/UPDATE.md")
            if paths["diff"].exists():
                archive.write(paths["diff"], "diff.json")
            if target_dir.exists():
                for rel, _size in walk_files(target_dir):
                    file_path = target_dir / rel
                    archive.write(file_path, f"code/{rel}")
        return {"ok": True, "path": str(archive_path)}

    # ------------------------------------------------------------------
    @app.get("/api/projects/{project_id}/search")
    async def search_files(project_id: str, q: str, side: str = "target") -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        root = paths["source"] if side == "source" else store.target_dir(project)
        if not root.exists():
            return {"results": []}
        results: list[dict[str, Any]] = []
        needle = q.strip()
        if not needle:
            return {"results": []}
        for rel, _size in walk_files(root):
            path = root / rel
            if needle.lower() in rel.lower():
                results.append({"path": rel, "size": _size, "reason": "path"})
                if len(results) >= 80:
                    break
                continue
            if is_binary(path) or path.stat().st_size > 400_000:
                continue
            text, _ = read_text(path, 400_000)
            if needle in text:
                results.append({"path": rel, "size": path.stat().st_size, "reason": "content"})
                if len(results) >= 80:
                    break
        return {"results": results}

    # ------------------------------------------------------------------
    # W3 凭证与模型
    # ------------------------------------------------------------------
    @app.post("/api/auth/w3/login")
    async def w3_login(body: W3LoginBody) -> dict[str, Any]:
        try:
            return await w3_auth.login(body.username, body.password)
        except W3AuthError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/auth/w3/status")
    async def w3_status() -> dict[str, Any]:
        await w3_auth.ensure_models()
        return w3_auth.status()

    @app.post("/api/auth/w3/logout")
    async def w3_logout() -> dict[str, Any]:
        return w3_auth.logout()

    @app.get("/api/models")
    async def list_models() -> dict[str, Any]:
        try:
            return await w3_auth.models()
        except W3AuthError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    # ------------------------------------------------------------------
    # Git 仓库
    # ------------------------------------------------------------------
    @app.get("/api/git/repos")
    async def git_repos(prefix: str = "") -> dict[str, Any]:
        return await git_ops.search_repos(prefix)

    @app.post("/api/projects/{project_id}/git/clone")
    async def git_clone(project_id: str, body: GitCloneBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            result = await asyncio.to_thread(git_ops.clone, project, body.url, body.branch)
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        await project_diff(project_id, refresh=1)
        return result

    @app.get("/api/projects/{project_id}/git/status")
    async def git_status(project_id: str) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await asyncio.to_thread(git_ops.status, project)
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/projects/{project_id}/git/branches")
    async def git_branches(project_id: str) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await asyncio.to_thread(git_ops.branches, project)
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/projects/{project_id}/git/compare")
    async def git_compare(project_id: str, base: str | None = None) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await asyncio.to_thread(git_ops.compare, project, base)
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.post("/api/projects/{project_id}/git/publish")
    async def git_publish(project_id: str, body: GitPublishBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await asyncio.to_thread(
                git_ops.publish,
                project,
                body.message,
                body.branch or "",
                body.push,
                body.remote,
                body.createBranch,
                body.force,
            )
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.post("/api/projects/{project_id}/git/push")
    async def git_push(project_id: str, body: GitPushBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await asyncio.to_thread(git_ops.push, project, body.branch, body.remote)
        except GitError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    # ------------------------------------------------------------------
    # 编辑器内 AI + 文件写回
    # ------------------------------------------------------------------
    @app.post("/api/projects/{project_id}/agent/edit")
    async def agent_edit(project_id: str, body: AgentEditBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await inline_agent.edit(
                project,
                body.path,
                body.instruction,
                body.startLine,
                body.endLine,
                body.content,
            )
        except InlineAgentError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.post("/api/projects/{project_id}/agent/explain")
    async def agent_explain(project_id: str, body: AgentExplainBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        try:
            return await inline_agent.explain(
                project,
                body.path,
                body.startLine,
                body.endLine,
                body.content,
                body.question,
            )
        except InlineAgentError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.post("/api/projects/{project_id}/files/write")
    async def write_file(project_id: str, body: FileWriteBody) -> dict[str, Any]:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "项目不存在")
        paths = store.paths(project_id)
        root = paths["source"] if body.side == "source" else store.target_dir(project)
        if not root.exists():
            raise HTTPException(409, "目标目录不存在，请先执行升级")
        try:
            target = safe_join(root, body.path)
        except ValueError as exc:
            raise HTTPException(400, "非法文件路径") from exc
        if has_binary_ext(body.path):
            raise HTTPException(400, "二进制文件不支持在线编辑")
        if len(body.content.encode("utf-8")) > 2_000_000:
            raise HTTPException(413, "文件内容过大")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.content, "utf-8")
        await project_diff(project_id, refresh=1)
        return {
            "ok": True,
            "path": body.path,
            "size": target.stat().st_size,
            "updatedAt": now_ms(),
        }

    @app.on_event("shutdown")
    async def shutdown() -> None:
        for task in list(tasks.values()):
            task.cancel()

    return app
