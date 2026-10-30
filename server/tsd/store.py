from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from .utils import bump_version, now_ms, slugify

UPGRADE_STEPS = [
    {"key": "fetch", "title": "解析方案页面"},
    {"key": "download", "title": "下载基础代码"},
    {"key": "analyze", "title": "分析项目结构"},
    {"key": "update", "title": "生成升级方案 (UPDATE.md)"},
    {"key": "code", "title": "升级代码"},
    {"key": "diff", "title": "计算差异"},
    {"key": "finalize", "title": "整理结果"},
]

CHAT_STEPS = [
    {"key": "context", "title": "读取项目上下文"},
    {"key": "reason", "title": "理解修改需求"},
    {"key": "patch", "title": "生成修改建议"},
]


class ProjectStore:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.root = workspace / "projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self.runs_dir = workspace / "runs"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir = workspace / "exports"
        self.exports_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    def project_dir(self, project_id: str) -> Path:
        return self.root / project_id

    def paths(self, project_id: str) -> dict[str, Path]:
        base = self.project_dir(project_id)
        return {
            "base": base,
            "meta": base / "project.json",
            "plan": base / "plan" / "PLAN.md",
            "update": base / "plan" / "UPDATE.md",
            "source": base / "source",
            "diff": base / "diff.json",
            "proposals": base / "proposals.json",
            "runs": base / "runs",
        }

    def target_dir(self, project: dict[str, Any]) -> Path:
        version = project.get("targetVersion") or "1.1.0"
        return self.project_dir(project["id"]) / f"v{version}"

    # ------------------------------------------------------------------
    def list_projects(self) -> list[dict[str, Any]]:
        projects: list[dict[str, Any]] = []
        for meta in sorted(self.root.glob("*/project.json")):
            try:
                data = json.loads(meta.read_text("utf-8"))
                data["workspace"] = str(self.project_dir(data["id"]))
                projects.append(data)
            except Exception:
                continue
        projects.sort(key=lambda p: p.get("updatedAt", 0), reverse=True)
        return projects

    def get(self, project_id: str) -> dict[str, Any] | None:
        meta = self.paths(project_id)["meta"]
        if not meta.exists():
            return None
        try:
            data = json.loads(meta.read_text("utf-8"))
        except Exception:
            return None
        self._refresh_paths(data)
        return data

    def _refresh_paths(self, project: dict[str, Any]) -> None:
        paths = self.paths(project["id"])
        project["workspace"] = str(paths["base"])
        if paths["plan"].exists():
            project["planPath"] = str(paths["plan"])
        if paths["update"].exists():
            project["updatePath"] = str(paths["update"])
        if paths["source"].exists() and any(paths["source"].iterdir()):
            project["sourceDir"] = str(paths["source"])
        target = self.target_dir(project)
        if target.exists() and any(target.iterdir()):
            project["targetDir"] = str(target)

    def save(self, project: dict[str, Any]) -> dict[str, Any]:
        paths = self.paths(project["id"])
        paths["base"].mkdir(parents=True, exist_ok=True)
        project["updatedAt"] = now_ms()
        self._refresh_paths(project)
        paths["meta"].write_text(json.dumps(project, indent=2, ensure_ascii=False), "utf-8")
        return project

    def create(
        self,
        name: str,
        source_url: str | None,
        source_kind: str,
        target_version: str | None,
        description: str | None,
    ) -> dict[str, Any]:
        project_id = uuid.uuid4().hex[:12]
        slug = slugify(name)
        base_version = "1.0.0"
        target = (target_version or "").strip() or bump_version(base_version, "minor")
        project: dict[str, Any] = {
            "id": project_id,
            "name": name.strip() or slug,
            "slug": slug,
            "sourceUrl": source_url or "",
            "sourceKind": source_kind or "page",
            "baseVersion": base_version,
            "targetVersion": target,
            "status": "draft",
            "createdAt": now_ms(),
            "updatedAt": now_ms(),
            "workspace": str(self.project_dir(project_id)),
            "description": description or "",
            "tags": [],
            "stats": {"files": 0, "added": 0, "removed": 0, "sections": 0, "filesChanged": 0},
        }
        (self.project_dir(project_id) / "plan").mkdir(parents=True, exist_ok=True)
        (self.project_dir(project_id) / "runs").mkdir(parents=True, exist_ok=True)
        return self.save(project)

    def update(self, project_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        project = self.get(project_id)
        if not project:
            return None
        for key, value in patch.items():
            if value is not None:
                project[key] = value
        return self.save(project)

    def delete(self, project_id: str) -> bool:
        base = self.project_dir(project_id)
        if base.exists():
            shutil.rmtree(base, ignore_errors=True)
            return True
        return False

    # ------------------------------------------------------------------
    def create_run(self, project: dict[str, Any], kind: str, prompt: str | None) -> dict[str, Any]:
        run_id = uuid.uuid4().hex[:12]
        steps = UPGRADE_STEPS if kind == "upgrade" else CHAT_STEPS
        run = {
            "id": run_id,
            "projectId": project["id"],
            "kind": kind,
            "status": "running",
            "prompt": prompt or "",
            "startedAt": now_ms(),
            "steps": [{"key": step["key"], "title": step["title"], "status": "pending"} for step in steps],
            "summary": "",
            "model": None,
            "usage": {},
            "cancelRequested": False,
        }
        self.save_run(run)
        return run

    def run_path(self, project_id: str, run_id: str) -> Path:
        return self.project_dir(project_id) / "runs" / f"{run_id}.json"

    def save_run(self, run: dict[str, Any]) -> None:
        path = self.run_path(run["projectId"], run["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {k: v for k, v in run.items() if k != "cancelRequested"}
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), "utf-8")

    def find_run(self, run_id: str) -> dict[str, Any] | None:
        for path in self.root.glob(f"*/runs/{run_id}.json"):
            try:
                return json.loads(path.read_text("utf-8"))
            except Exception:
                continue
        return None

    def list_runs(self, project_id: str) -> list[dict[str, Any]]:
        runs: list[dict[str, Any]] = []
        for path in sorted(self.project_dir(project_id).glob("runs/*.json"), reverse=True):
            try:
                runs.append(json.loads(path.read_text("utf-8")))
            except Exception:
                continue
        runs.sort(key=lambda r: r.get("startedAt", 0), reverse=True)
        return runs

    # ------------------------------------------------------------------
    def proposals(self, project_id: str) -> dict[str, Any]:
        path = self.paths(project_id)["proposals"]
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save_proposals(self, project_id: str, proposals: dict[str, Any]) -> None:
        path = self.paths(project_id)["proposals"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(proposals, indent=2, ensure_ascii=False), "utf-8")
