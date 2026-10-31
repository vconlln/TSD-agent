#!/usr/bin/env python3
"""生成一份演示工作区：真实跑通离线流水线，便于截图 / 首次体验。

用法：
    python scripts/seed_demo.py --workspace <dir>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
E2E = ROOT / "scripts" / "e2e"
SAMPLE = E2E / "sample-repo"

sys.path.insert(0, str(ROOT / "server"))

from tsd.auth import W3Auth  # noqa: E402
from tsd.chat import ChatAgent  # noqa: E402
from tsd.config import SettingsStore  # noqa: E402
from tsd.events import EventHub  # noqa: E402
from tsd.gitops import GitOps  # noqa: E402
from tsd.pipeline import UpgradePipeline  # noqa: E402
from tsd.store import ProjectStore  # noqa: E402


def seed_bare_repo(workspace: Path, name: str = "micabc") -> Path:
    """在 <workspace>/repos 下造一个带提交的裸仓库，供 Git 标签页演示。"""
    repos = workspace / "repos"
    repos.mkdir(parents=True, exist_ok=True)
    bare = repos / f"{name}.git"
    work = workspace / ".seed-work" / name
    for path in (bare, work):
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)

    def git(args: list[str], cwd: Path) -> None:
        result = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {result.stderr[-300:]}")

    subprocess.run(["git", "init", "--bare", "-b", "main", str(bare)], capture_output=True, text=True)
    git(["init", "-b", "main"], work)
    (work / "package.json").write_text(
        '{\n  "name": "micabc",\n  "version": "1.2.0",\n  "private": true\n}\n', "utf-8"
    )
    (work / "README.md").write_text(
        "# micabc\n\n订单中心示例仓库：订单创建、状态流转与支付回调。\n", "utf-8"
    )
    (work / "src").mkdir(exist_ok=True)
    (work / "src" / "index.ts").write_text(
        "export interface Order {\n"
        "  id: string\n"
        "  amount: number\n"
        "}\n\n"
        "export function createOrder(id: string, amount: number): Order {\n"
        "  if (amount <= 0) throw new Error('amount must be positive')\n"
        "  return { id, amount }\n"
        "}\n",
        "utf-8",
    )
    (work / "src" / "auth.ts").write_text(
        "export function verifySession(token: string): boolean {\n"
        "  return Boolean(token && token.length > 8)\n"
        "}\n",
        "utf-8",
    )
    git(["add", "-A"], work)
    git(["-c", "user.name=Seed", "-c", "user.email=seed@local", "commit", "-m", "chore: initial import"], work)
    git(["remote", "add", "origin", str(bare)], work)
    git(["push", "-u", "origin", "main"], work)
    return bare


def build_static(serve_dir: Path) -> None:
    serve_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(E2E / "plan.html", serve_dir / "index.html")
    archive = serve_dir / "sample-repo.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in SAMPLE.rglob("*"):
            if path.is_file():
                zf.write(path, f"sample-repo/{path.relative_to(SAMPLE).as_posix()}")


def start_static(serve_dir: Path) -> tuple[ThreadingHTTPServer, int]:
    handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(*args, directory=str(serve_dir), **kwargs)  # noqa: E731

    class Quiet(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            kwargs["directory"] = str(serve_dir)
            super().__init__(*args, **kwargs)

        def log_message(self, *args):  # noqa: D401
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


MOCK_LLM_DEFAULT = "http://127.0.0.1:8799/v1"


def mock_llm_base_url() -> str:
    """解析 TSD_DEMO_MOCK_LLM：可以是地址，也可以是开关。"""
    raw = (os.environ.get("TSD_DEMO_MOCK_LLM") or "").strip()
    if not raw:
        return ""
    if raw.lower() in ("1", "true", "yes", "on"):
        return MOCK_LLM_DEFAULT
    if not raw.startswith("http"):
        raise SystemExit(
            "TSD_DEMO_MOCK_LLM 需要是 http(s) 地址（如 " + MOCK_LLM_DEFAULT + "），当前：" + raw
        )
    return raw.rstrip("/")


async def seed(workspace: Path) -> dict:
    for key in list(os.environ):
        if "proxy" in key.lower():
            os.environ.pop(key)

    workspace.mkdir(parents=True, exist_ok=True)
    static_dir = workspace / ".static"
    build_static(static_dir)
    server, port = start_static(static_dir)

    store = ProjectStore(workspace)
    settings = SettingsStore(workspace)
    hub = EventHub(workspace / "runs")
    pipeline = UpgradePipeline(store, settings, hub)
    chat = ChatAgent(store, settings, hub)

    url = f"http://127.0.0.1:{port}/index.html"
    result: dict[str, object] = {}

    # 先配置推理引擎与 Agent 模式，后面的流水线才会走 Agent 循环
    # TSD_DEMO_MOCK_LLM 可以是一个完整地址（http://127.0.0.1:8799/v1），
    # 也可以是任意真值开关（1/true/yes），此时用默认本地 mock 地址。
    mock_llm = mock_llm_base_url()
    if mock_llm:
        settings.update(
            {
                "engine": {
                    "baseUrl": mock_llm,
                    "model": "mock-edit",
                    "apiKey": "mock-api-key",
                    "offlineMode": False,
                },
                "agent": {
                    "mode": "auto",
                    "maxSteps": 16,
                    "allowCommands": True,
                    "verify": True,
                },
            }
        )

    try:
        project = store.create("订单中心", url, "page", "1.5.0", "订单创建、状态流转与支付回调服务")
        run = store.create_run(project, "upgrade", "把鉴权升级为 JWT，补充刷新令牌；写操作增加审计日志；补充部署文档。")
        hub.create(run["id"])
        await pipeline.run(project, run, run["prompt"], "1.5.0")
        refreshed = store.get(project["id"])

        # seed one chat proposal so the chat view has content on first open
        chat_run = store.create_run(refreshed, "chat", "把这次升级的待办事项补充到 UPGRADE_NOTES.md")
        hub.create(chat_run["id"])
        await chat.run(refreshed, chat_run, chat_run["prompt"])

        second = store.create("支付网关", url, "page", "2.1.0", "支付渠道接入与对账")
        second_run = store.create_run(second, "upgrade", "新增支付宝渠道，统一回调签名校验。")
        hub.create(second_run["id"])
        await pipeline.run(second, second_run, second_run["prompt"], "2.1.0")

        draft = store.create("库存服务", url, "page", "1.1.0", "库存扣减与预占（待执行）")

        # Git 演示项目：本地裸仓库 → 克隆 → 升级（不推送，留给截图展示对比与推送表单）
        bare = seed_bare_repo(workspace)
        git_project = store.create("micabc", str(bare), "git", "1.3.0", "Git 仓库示例：订单中心")
        git_ops = GitOps(store, settings)
        git_ops.clone(git_project, str(bare))
        git_project = store.get(git_project["id"])
        git_run = store.create_run(git_project, "upgrade", "补充订单金额校验与鉴权说明，更新 README。")
        hub.create(git_run["id"])
        await pipeline.run(git_project, git_run, git_run["prompt"], "1.3.0")

        # W3 演示凭证（放在流水线之后，避免影响截图里的日志顺序）
        auth = W3Auth(settings)
        await auth.login("demo.engineer", "1234")

        result = {
            "workspace": str(workspace),
            "projectId": project["id"],
            "secondProjectId": second["id"],
            "draftProjectId": draft["id"],
            "gitProjectId": git_project["id"],
            "url": url,
        }
        # pick up the chat messages produced above
        proposals = store.proposals(project["id"])
        result["proposalCount"] = len(proposals)
    finally:
        server.shutdown()

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=str(ROOT / "scripts" / "e2e" / ".tmp" / "demo-workspace"))
    args = parser.parse_args()
    workspace = Path(args.workspace).expanduser().resolve()
    if (workspace / "projects").exists() and os.environ.get("TSD_DEMO_RESET") != "0":
        shutil.rmtree(workspace, ignore_errors=True)
    info = asyncio.run(seed(workspace))
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
