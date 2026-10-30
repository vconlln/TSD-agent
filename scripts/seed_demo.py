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

from tsd.chat import ChatAgent  # noqa: E402
from tsd.config import SettingsStore  # noqa: E402
from tsd.events import EventHub  # noqa: E402
from tsd.pipeline import UpgradePipeline  # noqa: E402
from tsd.store import ProjectStore  # noqa: E402


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

        result = {
            "workspace": str(workspace),
            "projectId": project["id"],
            "secondProjectId": second["id"],
            "draftProjectId": draft["id"],
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
