#!/usr/bin/env python3
"""Agent 模式端到端自测（mock 模型，不需要 API Key）。

覆盖：
1. 工具协议：读文件 → 改文件 → 跑测试 → finish
2. 验证阶段：测试通过后记录 verified
3. 工具沙箱：路径越界、危险命令、白名单外命令都会被拒绝
4. JSON 协议降级：agent.mode=json 时同样能完成修改
5. 结果落盘：差异里能看到 Agent 的改动

用法：python scripts/e2e/run_agent_e2e.py
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
INFO = "\033[96m•\033[0m"
failures: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        print(f"  {PASS} {label}" + (f"  ({detail})" if detail else ""))
        return True
    print(f"  {FAIL} {label}" + (f"  -> {detail}" if detail else ""))
    failures.append(label)
    return False


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def make_fixture(root: Path) -> Path:
    project = root / "fixture-agent-project"
    if project.exists():
        shutil.rmtree(project)
    (project / "src").mkdir(parents=True)
    (project / "package.json").write_text(
        '{\n  "name": "agent-demo",\n  "version": "1.0.0",\n'
        '  "scripts": { "test": "node -e \\"process.exit(0)\\"" }\n}\n',
        "utf-8",
    )
    (project / "README.md").write_text("# agent-demo\n\n用于 Agent 模式自测。\n", "utf-8")
    (project / "src" / "index.ts").write_text(
        "export interface Order {\n  id: string\n  amount: number\n}\n\n"
        "export function createOrder(id: string, amount: number): Order {\n"
        "  return { id, amount }\n}\n",
        "utf-8",
    )
    return project


async def wait_health(client: httpx.AsyncClient, base: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            response = await client.get(base + "/api/health", timeout=3)
            if response.status_code == 200:
                return response.json()
        except Exception:
            pass
        await asyncio.sleep(0.4)
    raise RuntimeError("后端未就绪")


async def wait_run(client: httpx.AsyncClient, base: str, run_id: str, timeout: float = 300) -> list[dict]:
    events: list[dict] = []
    deadline = time.time() + timeout
    async with client.stream("GET", base + "/api/runs/" + run_id + "/events?since=0", timeout=timeout) as response:
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
    return events


def tool_names(events: list[dict]) -> list[str]:
    return [str((e.get("data") or {}).get("tool")) for e in events if e.get("type") == "agent.tool"]


async def run_pipeline(client: httpx.AsyncClient, base: str, name: str, source: Path, mode: str | None) -> dict:
    if mode:
        await client.put(base + "/api/settings", json={"agent": {"mode": mode}})
    project = (
        await client.post(
            base + "/api/projects",
            json={"name": name, "sourceUrl": str(source), "sourceKind": "local", "targetVersion": "1.3.0"},
        )
    ).json()
    project_id = project["id"]
    run = (
        await client.post(
            base + "/api/projects/" + project_id + "/run",
            json={"upgradeRequest": "在入口文件顶部补充升级说明，并保证测试通过", "targetVersion": "1.3.0"},
        )
    ).json()
    events = await wait_run(client, base, run["runId"])
    diff = (await client.get(base + "/api/projects/" + project_id + "/diff", params={"refresh": 1})).json()
    project_state = (await client.get(base + "/api/projects/" + project_id)).json()
    return {
        "project_id": project_id,
        "events": events,
        "diff": diff,
        "project": project_state,
        "run_id": run["runId"],
    }


async def main() -> int:
    work_root = ROOT / "scripts" / "e2e" / ".tmp" / ("agent-" + str(int(time.time())))
    workspace = work_root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    source = make_fixture(work_root)

    mock_port = free_port()
    api_port = free_port()
    base = "http://127.0.0.1:" + str(api_port)
    mock = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / "e2e" / "mock_llm.py"), "--port", str(mock_port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    backend_log = (work_root / "server.log").open("wb")
    backend = subprocess.Popen(
        [sys.executable, str(ROOT / "server" / "main.py"), "--port", str(api_port), "--workspace", str(workspace)],
        stdout=backend_log,
        stderr=subprocess.STDOUT,
        env={**{k: v for k, v in os.environ.items() if "proxy" not in k.lower()}, "TSD_LLM_API_KEY": ""},
    )

    try:
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            await wait_health(client, base)
            time.sleep(1.0)
            # 指向 mock 模型，并打开 Agent 模式
            await client.put(
                base + "/api/settings",
                json={
                    "engine": {
                        "baseUrl": "http://127.0.0.1:" + str(mock_port) + "/v1",
                        "apiKey": "mock-key",
                        "model": "mock-edit",
                        "offlineMode": False,
                    },
                    "agent": {"mode": "auto", "maxSteps": 12, "allowCommands": True, "verify": True},
                },
            )
            health = (await client.get(base + "/api/health")).json()
            check(health["engine"] == "online", "推理引擎在线", health.get("model"))

            print("\n=== 1. 工具协议 Agent ===")
            result = await run_pipeline(client, base, "agent-tools", source, None)
            events = result["events"]
            names = tool_names(events)
            check("run.done" in {e.get("type") for e in events}, "流水线完成")
            check("read_file" in names, "调用了 read_file", ",".join(names))
            check("edit_file" in names, "调用了 edit_file")
            check("run_tests" in names, "调用了 run_tests")

            verify_events = [e for e in events if e.get("type") == "agent.verify"]
            check(len(verify_events) >= 1, "记录了验证结果", str(len(verify_events)))
            check(any((e.get("data") or {}).get("ok") for e in verify_events), "验证通过")

            thoughts = [e for e in events if e.get("type") == "agent.thought"]
            check(len(thoughts) >= 2, "有思考过程", str(len(thoughts)))

            step_event = [
                e for e in events
                if e.get("type") == "step.status" and (e.get("data") or {}).get("key") == "code"
                and (e.get("data") or {}).get("status") == "done"
            ]
            check(bool(step_event), "code 步骤完成")
            code_metrics = (step_event[-1].get("data") or {}).get("metrics") if step_event else {}
            check(bool(code_metrics), "code 步骤带工具指标", json.dumps(code_metrics or {}, ensure_ascii=False))

            files = {f["path"]: f for f in result["diff"]["files"]}
            changed = files.get("src/index.ts")
            check(changed is not None, "差异包含 src/index.ts")
            check(changed is not None and "[AI]" in changed["patch"], "补丁里能看到 Agent 的改动")
            check(result["project"]["stats"]["filesChanged"] >= 1, "项目统计已更新")

            persisted = (await client.get(base + "/api/runs/" + result["run_id"])).json()
            steps = (persisted.get("run") or persisted).get("steps") or []
            done_steps = [s for s in steps if s.get("status") == "done"]
            check(len(steps) >= 5, "步骤列表已落盘", str(len(steps)))
            check(len(done_steps) >= 5, "步骤状态已持久化", str(len(done_steps)))
            check(
                any(s.get("key") == "code" and s.get("metrics") for s in steps),
                "落盘步骤带工具指标",
            )

            print("\n=== 2. JSON 协议降级 ===")
            result2 = await run_pipeline(client, base, "agent-json", source, "json")
            names2 = tool_names(result2["events"])
            check("read_file" in names2, "JSON 协议下读取了文件", ",".join(names2))
            check("write_file" in names2, "JSON 协议下写入了文件")
            files2 = {f["path"]: f for f in result2["diff"]["files"]}
            check("src/index.ts" in files2, "JSON 协议改动已落盘")

            print("\n=== 3. 工具沙箱 ===")
            sys.path.insert(0, str(ROOT / "server"))
            from tsd.toolbox import Toolbox

            sandbox_root = work_root / "sandbox"
            sandbox_root.mkdir(exist_ok=True)
            (sandbox_root / "a.txt").write_text("hello\n", "utf-8")
            box = Toolbox(sandbox_root, allow_commands=True)

            escape = await box.call("read_file", {"path": "../outside.txt"})
            check(not escape.ok, "路径越界被拒绝", escape.content[:60])

            blocked = await box.call("run_command", {"command": "sudo rm -rf /"})
            check(not blocked.ok, "危险命令被拒绝", blocked.content[:60])

            not_allowed = await box.call("run_command", {"command": "curl http://example.com"})
            check(not_allowed.ok is False, "白名单外命令被拒绝", not_allowed.content[:60])

            no_cmds = Toolbox(sandbox_root, allow_commands=False)
            denied = await no_cmds.call("run_command", {"command": "node -v"})
            check(denied.ok is False, "关闭命令执行后会被拦截", denied.content[:40])

            edit = await box.call(
                "edit_file", {"path": "a.txt", "old_string": "hello", "new_string": "hello world"}
            )
            check(edit.ok, "沙箱内编辑可用", edit.content[:60])
            missing = await box.call(
                "edit_file", {"path": "a.txt", "old_string": "not-there", "new_string": "x"}
            )
            check(missing.ok is False, "old_string 不匹配时给出提示", missing.content[:60])

    except Exception as exc:  # noqa: BLE001
        import traceback

        print("\n" + FAIL + " 测试异常：" + str(exc))
        traceback.print_exc()
        failures.append("unexpected-exception")
    finally:
        backend.terminate()
        mock.terminate()
        for proc in (backend, mock):
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
        backend_log.close()

    print("\n" + "=" * 56)
    if failures:
        print(FAIL + " 失败 " + str(len(failures)) + " 项：" + ", ".join(failures))
        print(INFO + " 日志：" + str(work_root / "server.log"))
        return 1
    print(PASS + " 全部通过")
    shutil.rmtree(work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
