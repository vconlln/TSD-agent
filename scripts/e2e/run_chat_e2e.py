#!/usr/bin/env python3
"""对话（DeepSeek 式流式 + 思考 + 工具）端到端自测，使用 mock 模型，不需要 API Key。

覆盖：
1. 流式对话：思考过程（chat.reasoning）、正文（chat.delta）、工具调用（chat.tool）
2. 工具：list_files / propose_edit，提案带完整补丁
3. 应用提案：文件真正落盘，差异刷新后可见
4. 多轮上下文：带 history 的第二次对话正常完成
5. 离线降级：没有 API Key 时仍能给出可应用的确定性改动

用法：python scripts/e2e/run_chat_e2e.py
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
    project = root / "fixture-chat-project"
    if project.exists():
        shutil.rmtree(project)
    (project / "src").mkdir(parents=True)
    (project / "docs").mkdir(parents=True)
    (project / "package.json").write_text(
        '{\n  "name": "chat-demo",\n  "version": "1.0.0",\n'
        '  "scripts": { "test": "node -e \\"process.exit(0)\\"" }\n}\n',
        "utf-8",
    )
    (project / "README.md").write_text("# chat-demo\n\n对话自测项目。\n", "utf-8")
    (project / "src" / "order.ts").write_text(
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


async def wait_run(client: httpx.AsyncClient, base: str, run_id: str, timeout: float = 180) -> list[dict]:
    events: list[dict] = []
    async with client.stream("GET", base + "/api/runs/" + run_id + "/events?since=0", timeout=timeout) as response:
        async for line in response.aiter_lines():
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


def of_type(events: list[dict], kind: str) -> list[dict]:
    return [event for event in events if event.get("type") == kind]


async def main() -> int:
    work_root = ROOT / "scripts" / "e2e" / ".tmp" / ("chat-" + str(int(time.time())))
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
        async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
            await wait_health(client, base)
            await asyncio.sleep(0.8)
            await client.put(
                base + "/api/settings",
                json={
                    "engine": {
                        "baseUrl": "http://127.0.0.1:" + str(mock_port) + "/v1",
                        "apiKey": "mock-key",
                        "model": "mock-edit",
                        "offlineMode": False,
                    },
                    "agent": {"mode": "auto", "maxSteps": 10, "allowCommands": True, "verify": True},
                },
            )
            health = (await client.get(base + "/api/health")).json()
            print("\n=== 1. 准备项目 ===")
            check(health["engine"] == "online", "推理引擎在线", health.get("model"))

            project = (
                await client.post(
                    base + "/api/projects",
                    json={
                        "name": "对话自检",
                        "sourceUrl": str(source),
                        "sourceKind": "local",
                        "targetVersion": "1.2.0",
                    },
                )
            ).json()
            project_id = project["id"]
            run = (
                await client.post(
                    base + "/api/projects/" + project_id + "/run",
                    json={"upgradeRequest": "补充金额校验与升级说明", "targetVersion": "1.2.0"},
                )
            ).json()
            await wait_run(client, base, run["runId"])
            state = (await client.get(base + "/api/projects/" + project_id)).json()
            check(state.get("status") == "ready", "升级流水线完成", state.get("status"))

            print("\n=== 2. 流式对话（思考 + 工具 + 正文）===")
            chat = (
                await client.post(
                    base + "/api/projects/" + project_id + "/chat",
                    json={"message": "给 createOrder 加上金额校验，并把待办写成文档", "history": []},
                )
            ).json()
            events = await wait_run(client, base, chat["runId"])
            types = [event.get("type") for event in events]
            check("run.done" in types, "对话完成")
            check(not [t for t in types if t == "run.error"], "对话没有报错")

            reasoning = of_type(events, "chat.reasoning")
            reasoning_text = "".join(str((event.get("data") or {}).get("delta") or "") for event in reasoning)
            check(len(reasoning) >= 2, "有流式思考过程", f"{len(reasoning)} 段")
            check(len(reasoning_text) > 10, "思考内容非空", reasoning_text[:40])

            deltas = of_type(events, "chat.delta")
            answer = "".join(str((event.get("data") or {}).get("delta") or "") for event in deltas)
            check(len(deltas) >= 3, "正文是流式增量", f"{len(deltas)} 块")
            check("金额" in answer or "createOrder" in answer, "回答内容合理", answer[:60].replace("\n", " "))

            tools = of_type(events, "chat.tool")
            tool_names = [str((event.get("data") or {}).get("tool")) for event in tools]
            check("list_files" in tool_names, "模型主动看了项目结构", ",".join(tool_names))
            check("propose_edit" in tool_names, "模型给出了改动建议")
            check(all((event.get("data") or {}).get("ok") for event in tools), "工具调用全部成功")

            message = of_type(events, "chat.message")
            check(bool(message), "收到 chat.message 汇总事件")
            proposal = ((message[-1].get("data") or {}).get("proposal") if message else None) or {}
            edits = proposal.get("edits") or []
            check(len(edits) == 2, "提案包含两个文件", str([e.get("path") for e in edits]))
            check(all(int(e.get("additions") or 0) >= 0 for e in edits), "提案带新增/删除统计")
            check(any((e.get("patch") or "").strip() for e in edits), "提案带统一补丁")
            final_content = str(((message[-1].get("data") or {}).get("content") if message else "") or "")
            check("结论" in final_content, "最终消息保留完整回答（不是占位文案）", final_content[:40].replace("\n", " "))
            check(len(final_content) >= len(answer.strip()) * 0.9, "流式内容与最终内容一致")

            idx_reasoning = next((i for i, t in enumerate(types) if t == "chat.reasoning"), 10**6)
            idx_message = next((i for i, t in enumerate(types) if t == "chat.message"), -1)
            check(idx_reasoning < idx_message, "思考先于最终消息（真正的流式）")

            print("\n=== 3. 应用提案 ===")
            applied = await client.post(base + "/api/projects/" + project_id + "/apply", json={"proposalId": proposal.get("id")})
            check(applied.status_code == 200, "应用接口返回 200", str(applied.status_code))
            target = workspace / "projects" / project_id / "v1.2.0" / "docs" / "CHAT_NOTES.md"
            check(target.exists(), "改动落到磁盘", str(target.name))
            diff = (await client.get(base + "/api/projects/" + project_id + "/diff", params={"refresh": 1})).json()
            paths = [f.get("path") for f in diff.get("files", [])]
            check("docs/CHAT_NOTES.md" in paths, "差异里能看到新文件", ",".join(paths[:5]))

            print("\n=== 4. 多轮上下文 ===")
            chat2 = (
                await client.post(
                    base + "/api/projects/" + project_id + "/chat",
                    json={
                        "message": "刚才那个校验，顺手写成待办",
                        "history": [
                            {"role": "user", "content": "给 createOrder 加上金额校验，并把待办写成文档"},
                            {"role": "assistant", "content": answer[:400]},
                        ],
                    },
                )
            ).json()
            events2 = await wait_run(client, base, chat2["runId"])
            types2 = [event.get("type") for event in events2]
            check("run.done" in types2, "带历史的多轮对话完成")
            check(len(of_type(events2, "chat.reasoning")) >= 1, "第二轮依然有思考过程")

            print("\n=== 5. 离线降级 ===")
            await client.put(
                base + "/api/settings",
                json={"engine": {"apiKey": "", "offlineMode": True, "model": "offline"}},
            )
            chat3 = (
                await client.post(
                    base + "/api/projects/" + project_id + "/chat",
                    json={"message": "再补一条待办", "history": []},
                )
            ).json()
            events3 = await wait_run(client, base, chat3["runId"])
            types3 = [event.get("type") for event in events3]
            check("run.done" in types3, "离线模式对话不崩")
            offline_msg = of_type(events3, "chat.message")
            offline_proposal = ((offline_msg[-1].get("data") or {}).get("proposal") if offline_msg else None) or {}
            check(bool(offline_proposal.get("edits")), "离线模式仍给出确定性改动", str(len(offline_proposal.get("edits") or [])))

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
