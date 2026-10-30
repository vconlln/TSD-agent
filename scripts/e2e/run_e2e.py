#!/usr/bin/env python3
"""TSD Agent 端到端自测。

覆盖链路：
1. 启动静态站点（上一层的方案页面 plan.html）
2. 启动后端（内置离线模式，无需 API Key）
3. 创建项目 → 解析页面 → 发现 zip → 下载 → 生成 UPDATE.md → 升级代码 → 计算差异
4. 校验文档 / 差异 / 目录树 / 文件内容 / 导出
5. 对话 → 生成补丁 → 应用补丁 → 差异更新

用法：
    python scripts/e2e/run_e2e.py            # 使用 .venv 里的 Python 也行
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
import tempfile
import time
import zipfile
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SAMPLE = HERE / "sample-repo"
PLAN_PAGE = HERE / "plan.html"

PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
INFO = "\033[96m•\033[0m"

failures: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        print(f"  {PASS} {label}" + (f"  ({detail})" if detail else ""))
        return True
    print(f"  {FAIL} {label}" + (f"  → {detail}" if detail else ""))
    failures.append(label)
    return False


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def prepare_static(serve_dir: Path) -> None:
    serve_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PLAN_PAGE, serve_dir / "index.html")
    archive_path = serve_dir / "sample-repo.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in SAMPLE.rglob("*"):
            if path.is_file():
                archive.write(path, f"sample-repo/{path.relative_to(SAMPLE).as_posix()}")


async def wait_health(client: httpx.AsyncClient, base: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        try:
            response = await client.get(f"{base}/api/health", timeout=3)
            if response.status_code == 200:
                return response.json()
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        await asyncio.sleep(0.4)
    raise RuntimeError(f"后端未就绪：{last_error}")


async def collect_events(client: httpx.AsyncClient, base: str, run_id: str, timeout: float = 240) -> list[dict]:
    events: list[dict] = []
    deadline = time.time() + timeout
    try:
        async with client.stream("GET", f"{base}/api/runs/{run_id}/events?since=0", timeout=timeout) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if time.time() > deadline:
                    break
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except Exception:
                    continue
                events.append(event)
                if event.get("type") in ("run.done", "run.error"):
                    break
    except (httpx.HTTPError, asyncio.TimeoutError) as exc:
        print(f"  {INFO} 事件流中断：{exc}")
    return events


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="保留临时工作目录")
    parser.add_argument("--verbose", action="store_true", help="打印全部事件")
    args = parser.parse_args()

    tmp_parent = ROOT / "scripts" / "e2e" / ".tmp"
    tmp_parent.mkdir(parents=True, exist_ok=True)
    work_root = Path(tempfile.mkdtemp(prefix="tsd-e2e-", dir=tmp_parent))
    workspace = work_root / "workspace"
    serve_dir = work_root / "static"
    prepare_static(serve_dir)

    static_port = free_port()
    api_port = free_port()
    static_url = f"http://127.0.0.1:{static_port}/index.html"
    base = f"http://127.0.0.1:{api_port}"

    print(f"{INFO} 临时目录：{work_root}")
    print(f"{INFO} 方案页：{static_url}")

    server_log = (work_root / "server.log").open("wb")
    static_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(static_port), "--bind", "127.0.0.1", "--directory", str(serve_dir)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    backend_proc = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "server" / "main.py"),
            "--port",
            str(api_port),
            "--workspace",
            str(workspace),
        ],
        stdout=server_log,
        stderr=subprocess.STDOUT,
        env={
            **{k: v for k, v in os.environ.items() if "proxy" not in k.lower()},
            "TSD_LLM_API_KEY": "",
        },
    )

    exit_code = 0
    try:
        async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
            print("\n=== 1. 后端健康检查 ===")
            health = await wait_health(client, base)
            check(health.get("ok") is True, "后端可用", f"v{health.get('version')}")
            check(health.get("engine") == "offline", "离线模式（未配置密钥）", str(health.get("engine")))

            print("\n=== 2. 创建项目 ===")
            created = await client.post(
                f"{base}/api/projects",
                json={
                    "name": "订单中心 E2E",
                    "sourceUrl": static_url,
                    "sourceKind": "page",
                    "targetVersion": "1.5.0",
                    "description": "端到端自测项目",
                },
            )
            check(created.status_code == 200, "项目创建成功", f"HTTP {created.status_code}")
            project = created.json()
            project_id = project["id"]

            print("\n=== 3. 执行升级流水线 ===")
            request_text = (
                "为鉴权升级为 JWT，并补充刷新令牌接口；\n"
                "所有写操作增加审计日志；\n"
                "补充部署与回滚文档。"
            )
            run_response = await client.post(
                f"{base}/api/projects/{project_id}/run",
                json={"upgradeRequest": request_text, "targetVersion": "1.5.0"},
            )
            check(run_response.status_code == 200, "任务已启动", f"HTTP {run_response.status_code}")
            run_id = run_response.json()["runId"]
            events = await collect_events(client, base, run_id)
            if args.verbose:
                for event in events:
                    print("   ", json.dumps(event, ensure_ascii=False)[:220])

            types = {event.get("type") for event in events}
            check("run.status" in types, "收到 run.status 事件")
            check("step.status" in types, "收到 step.status 事件")
            check("run.done" in types, "流水线以 run.done 结束")
            check(not any(event.get("type") == "run.error" for event in events), "未出现 run.error")
            step_done = {
                (event.get("data") or {}).get("key")
                for event in events
                if event.get("type") == "step.status" and (event.get("data") or {}).get("status") == "done"
            }
            for expected in ("fetch", "download", "analyze", "update", "code", "diff", "finalize"):
                check(expected in step_done, f"步骤完成：{expected}")

            print("\n=== 4. 校验产物 ===")
            project_after = (await client.get(f"{base}/api/projects/{project_id}")).json()
            check(project_after.get("status") == "ready", "项目状态 ready", str(project_after.get("status")))
            check(
                (project_after.get("baseVersion") or "") != "",
                "已探测基础版本",
                str(project_after.get("baseVersion")),
            )

            documents = (await client.get(f"{base}/api/projects/{project_id}/documents")).json()
            check(documents["plan"]["exists"], "PLAN.md 已生成", f"{len(documents['plan']['content'])} 字符")
            check(documents["update"]["exists"], "UPDATE.md 已生成", f"{len(documents['update']['content'])} 字符")
            check("升级方案" in documents["update"]["content"], "UPDATE.md 含升级方案章节")
            check("订单中心" in documents["plan"]["content"], "PLAN.md 抓到页面正文")

            diff = (await client.get(f"{base}/api/projects/{project_id}/diff?refresh=1")).json()
            files = diff["files"]
            check(len(files) >= 3, "代码差异文件数 >= 3", f"{len(files)} 个")
            check(diff["stats"]["added"] > 0, "有新增行", f"+{diff['stats']['added']}")
            check(
                any(f["status"] == "added" for f in files),
                "存在新增文件",
                ", ".join(f["path"] for f in files if f["status"] == "added")[:120],
            )
            check(
                any(f["status"] == "modified" for f in files),
                "存在修改文件",
                ", ".join(f["path"] for f in files if f["status"] == "modified")[:120],
            )
            check(len(diff["plan"]["sections"]) > 0, "方案按章节解析", f"{len(diff['plan']['sections'])} 段")
            check(bool(diff["plan"]["unified"]), "方案统一差异可生成")
            patched = [f for f in files if f["patch"].startswith("---")]
            check(len(patched) == len(files), "每个文件都有统一差异补丁", f"{len(patched)}/{len(files)}")

            tree = (await client.get(f"{base}/api/projects/{project_id}/tree?side=target")).json()
            check(tree["exists"] and tree["tree"], "升级后目录树可读取")
            source_tree = (await client.get(f"{base}/api/projects/{project_id}/tree?side=source")).json()
            check(source_tree["exists"] and source_tree["tree"], "原始代码目录树可读取")

            file_path = "package.json"
            file_response = await client.get(
                f"{base}/api/projects/{project_id}/file", params={"side": "target", "path": file_path}
            )
            check(file_response.status_code == 200, "文件内容接口可用")
            package = json.loads(file_response.json()["content"])
            check(package.get("version") == "1.5.0", "package.json 版本已提升", str(package.get("version")))

            print("\n=== 5. 对话与补丁 ===")
            chat = await client.post(
                f"{base}/api/projects/{project_id}/chat",
                json={"message": "请把这次升级的待办事项补充到 UPGRADE_NOTES.md"},
            )
            check(chat.status_code == 200, "对话请求已接受")
            chat_run = chat.json()["runId"]
            chat_events = await collect_events(client, base, chat_run)
            chat_types = {event.get("type") for event in chat_events}
            check("chat.delta" in chat_types, "收到流式增量 chat.delta")
            check("chat.message" in chat_types, "收到 chat.message")
            proposal = None
            for event in chat_events:
                if event.get("type") in ("chat.message", "chat.proposal"):
                    candidate = (event.get("data") or {}).get("proposal")
                    if candidate:
                        proposal = candidate
            check(proposal is not None, "生成代码修改建议")
            if proposal:
                check(len(proposal["edits"]) > 0, "建议包含文件改动", f"{len(proposal['edits'])} 个")
                applied = await client.post(
                    f"{base}/api/projects/{project_id}/apply", json={"proposalId": proposal["id"]}
                )
                check(applied.status_code == 200, "补丁应用成功")
                print(f"  {INFO} 已应用：{', '.join(applied.json().get('files', []))}")

            print("\n=== 6. 导出 ===")
            export = await client.post(f"{base}/api/projects/{project_id}/export")
            check(export.status_code == 200, "导出接口可用")
            if export.status_code == 200:
                archive = Path(export.json()["path"])
                check(archive.exists(), "导出压缩包已生成", archive.name)
                if archive.exists():
                    with zipfile.ZipFile(archive) as zf:
                        names = zf.namelist()
                    check(any(name.startswith("code/") for name in names), "压缩包含升级后代码")
                    check(any(name.startswith("plan/") for name in names), "压缩包含方案文档")

            print("\n=== 7. 项目列表 / 删除 ===")
            listing = (await client.get(f"{base}/api/projects")).json()
            check(any(item["id"] == project_id for item in listing["projects"]), "项目出现在列表中")
            deleted = await client.delete(f"{base}/api/projects/{project_id}")
            check(deleted.status_code == 200, "项目删除成功")

    except Exception as exc:  # noqa: BLE001
        import traceback

        print(f"\n{FAIL} 测试异常：{exc}")
        traceback.print_exc()
        failures.append("unexpected-exception")
    finally:
        backend_proc.terminate()
        static_proc.terminate()
        try:
            backend_proc.wait(timeout=8)
        except Exception:
            backend_proc.kill()
        try:
            static_proc.wait(timeout=5)
        except Exception:
            static_proc.kill()
        server_log.close()

    print("\n" + "=" * 56)
    if failures:
        print(f"{FAIL} 失败 {len(failures)} 项：{', '.join(failures)}")
        print(f"{INFO} 服务端日志：{work_root / 'server.log'}")
        exit_code = 1
    else:
        print(f"{PASS} 全部通过")
        if not args.keep:
            shutil.rmtree(work_root, ignore_errors=True)
        else:
            print(f"{INFO} 保留目录：{work_root}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
