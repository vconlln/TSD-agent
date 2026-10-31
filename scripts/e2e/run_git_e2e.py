#!/usr/bin/env python3
"""W3 凭证 / Git 仓库 / 编辑器内 AI 的端到端自测（离线模式，无需 API Key）。

覆盖：
1. W3 演示登录 -> 凭证 -> 模型清单
2. 按前缀检索本地仓库（裸仓库）
3. 克隆到项目 -> 升级流水线 -> 目标目录
4. 本地 vs 远程对比（ahead/behind）
5. 新建分支 + 提交 + 推送（推到裸仓库并校验引用）
6. 编辑器 AI：解释（离线静态分析）、修改（未配置模型时给出明确错误）
7. 文件写回接口 + 差异刷新

用法：python scripts/e2e/run_git_e2e.py
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


def run_git(args: list[str], cwd: Path | None = None) -> None:
    result = subprocess.run(["git", *args], cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError("git " + " ".join(args) + ": " + result.stderr[-300:])


def seed_repos(root: Path) -> Path:
    """在 <workspace>/repos 下造一个裸仓库 micabc.git，带一次提交。"""
    repos = root / "repos"
    repos.mkdir(parents=True, exist_ok=True)
    bare = repos / "micabc.git"
    work = root / "seed-work"
    if bare.exists():
        shutil.rmtree(bare)
    if work.exists():
        shutil.rmtree(work)
    run_git(["init", "--bare", "-b", "main", str(bare)])
    work.mkdir(parents=True)
    run_git(["init", "-b", "main"], work)
    (work / "package.json").write_text('{\n  "name": "micabc",\n  "version": "1.2.0"\n}\n', "utf-8")
    (work / "README.md").write_text("# micabc\n\n示例仓库，用于端到端测试。\n", "utf-8")
    (work / "src").mkdir()
    (work / "src" / "index.ts").write_text(
        "export function greet(name: string): string {\n"
        "  return 'hello ' + name\n"
        "}\n",
        "utf-8",
    )
    run_git(["add", "-A"], work)
    run_git(["-c", "user.name=Seed", "-c", "user.email=seed@local", "commit", "-m", "chore: seed"], work)
    run_git(["remote", "add", "origin", str(bare)], work)
    run_git(["push", "-u", "origin", "main"], work)
    return bare


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


async def wait_run(client: httpx.AsyncClient, base: str, run_id: str, timeout: float = 240) -> list[dict]:
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


async def main() -> int:
    work_root = ROOT / "scripts" / "e2e" / ".tmp" / ("git-" + str(int(time.time())))
    workspace = work_root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    bare = seed_repos(workspace)
    print(INFO + " 临时工作区：" + str(workspace))
    print(INFO + " 裸仓库：" + str(bare))

    port = free_port()
    base = "http://127.0.0.1:" + str(port)
    log = (work_root / "server.log").open("wb")
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server" / "main.py"), "--port", str(port), "--workspace", str(workspace)],
        stdout=log,
        stderr=subprocess.STDOUT,
        env={**{k: v for k, v in os.environ.items() if "proxy" not in k.lower()}, "TSD_LLM_API_KEY": ""},
    )

    try:
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            await wait_health(client, base)
            print("\n=== 1. W3 凭证 ===")
            status = (await client.get(base + "/api/auth/w3/status")).json()
            check(status["authenticated"] is False, "初始未登录")
            check(status["mode"] == "demo", "未配置网关时为演示模式", status["mode"])

            bad = await client.post(base + "/api/auth/w3/login", json={"username": "alice", "password": "123"})
            check(bad.status_code == 400, "演示模式拒绝过短密码", "HTTP " + str(bad.status_code))

            login = await client.post(base + "/api/auth/w3/login", json={"username": "alice", "password": "1234"})
            check(login.status_code == 200, "登录成功", "HTTP " + str(login.status_code))
            session = login.json()
            check(session["authenticated"] is True, "返回已认证状态")
            check(bool(session.get("tokenPreview")), "返回凭证摘要", str(session.get("tokenPreview")))
            check(session["user"]["name"] == "alice", "返回用户信息", session["user"]["name"])

            models = (await client.get(base + "/api/models")).json()
            check(len(models["models"]) >= 3, "模型清单可用", str(len(models["models"])) + " 个")
            check(models["source"] == "builtin", "演示模式模型来源", models["source"])

            print("\n=== 2. 仓库检索 ===")
            repos = (await client.get(base + "/api/git/repos", params={"prefix": "mic"})).json()
            names = [repo["name"] for repo in repos["repos"]]
            check("micabc.git" in names, "按前缀命中裸仓库", ",".join(names))
            empty = (await client.get(base + "/api/git/repos", params={"prefix": "zzz"})).json()
            check(len(empty["repos"]) == 0, "无匹配时返回空列表")

            print("\n=== 3. 项目克隆 + 升级 ===")
            project = (
                await client.post(
                    base + "/api/projects",
                    json={"name": "micabc", "sourceUrl": str(bare), "sourceKind": "git", "targetVersion": "1.3.0"},
                )
            ).json()
            project_id = project["id"]
            clone = await client.post(base + "/api/projects/" + project_id + "/git/clone", json={"url": str(bare)})
            check(clone.status_code == 200, "克隆成功", "HTTP " + str(clone.status_code))
            clone_data = clone.json()
            check(clone_data["files"] >= 3, "克隆到文件", str(clone_data["files"]))
            check(clone_data["branch"] == "main", "克隆分支正确", clone_data["branch"])

            run = (
                await client.post(
                    base + "/api/projects/" + project_id + "/run",
                    json={"upgradeRequest": "把问候函数改为支持多语言\n补充 README 使用说明", "targetVersion": "1.3.0"},
                )
            ).json()
            events = await wait_run(client, base, run["runId"])
            check(any(e.get("type") == "run.done" for e in events), "升级流水线完成")
            steps = {
                (e.get("data") or {}).get("key")
                for e in events
                if e.get("type") == "step.status" and (e.get("data") or {}).get("status") == "done"
            }
            check("download" in steps, "下载步骤复用已有克隆")
            diff = (await client.get(base + "/api/projects/" + project_id + "/diff", params={"refresh": 1})).json()
            check(diff["stats"]["filesChanged"] >= 1, "产生代码差异", str(diff["stats"]["filesChanged"]) + " 个文件")

            print("\n=== 4. 本地 vs 远程对比 ===")
            git_status = (await client.get(base + "/api/projects/" + project_id + "/git/status")).json()
            check(git_status["initialized"] is True, "识别为 Git 仓库")
            check(git_status["branch"] == "main", "当前分支 main", str(git_status.get("branch")))
            check(git_status["dirty"] == [], "工作区干净（升级结果尚未同步）")

            compare = (await client.get(base + "/api/projects/" + project_id + "/git/compare")).json()
            check(compare["ok"] is True, "对比可用", str(compare.get("base")))
            check(
                compare["ahead"] == 0 and compare["behind"] == 0,
                "与远程一致",
                "ahead=" + str(compare["ahead"]) + " behind=" + str(compare["behind"]),
            )

            print("\n=== 5. 建分支 + 提交 + 推送 ===")
            publish = await client.post(
                base + "/api/projects/" + project_id + "/git/publish",
                json={
                    "message": "feat: upgrade micabc to v1.3.0",
                    "branch": "upgrade/v1.3.0",
                    "push": True,
                    "createBranch": True,
                },
            )
            check(publish.status_code == 200, "提交接口成功", "HTTP " + str(publish.status_code))
            published = publish.json()
            check(published["ok"] is True, "提交并推送成功", json.dumps(published.get("files", []), ensure_ascii=False)[:120])
            check(published["pushed"] is True, "已推送远程")
            check(published["branch"] == "upgrade/v1.3.0", "分支名正确", published["branch"])

            refs = subprocess.run(
                ["git", "--git-dir", str(bare), "branch", "--list"], capture_output=True, text=True
            ).stdout
            check("upgrade/v1.3.0" in refs, "裸仓库已收到新分支", refs.replace("\n", " ").strip())

            # 推送后本分支已与 upstream 同步，因此显式对比 origin/main 才能看到领先提交
            after = (
                await client.get(base + "/api/projects/" + project_id + "/git/compare", params={"base": "origin/main"})
            ).json()
            check(after["ahead"] >= 1, "对比 origin/main 显示领先提交", "ahead=" + str(after["ahead"]))
            check(
                len(after.get("files") or []) >= 2,
                "对比列出变更文件",
                str(len(after.get("files") or [])) + " 个",
            )

            print("\n=== 6. 编辑器内 AI ===")
            explain = await client.post(
                base + "/api/projects/" + project_id + "/agent/explain",
                json={"path": "src/index.ts", "startLine": 1, "endLine": 3},
            )
            check(explain.status_code == 200, "解释接口可用", "HTTP " + str(explain.status_code))
            explain_data = explain.json()
            check(explain_data["ok"] is True and explain_data["mode"] == "offline", "离线解释降级", explain_data["mode"])
            check("函数" in explain_data["text"] or "概览" in explain_data["text"], "返回结构化解释")

            edit = await client.post(
                base + "/api/projects/" + project_id + "/agent/edit",
                json={"path": "src/index.ts", "instruction": "加上中文注释", "startLine": 1, "endLine": 3},
            )
            check(edit.status_code == 200, "修改接口可用")
            edit_data = edit.json()
            check(edit_data["ok"] is False, "未配置模型时明确拒绝")
            check("推理引擎" in (edit_data.get("error") or ""), "给出可操作提示", (edit_data.get("error") or "")[:60])

            print("\n=== 7. 文件写回 ===")
            content = (
                await client.get(
                    base + "/api/projects/" + project_id + "/file",
                    params={"side": "target", "path": "src/index.ts"},
                )
            ).json()
            new_content = content["content"].replace("hello", "你好")
            written = await client.post(
                base + "/api/projects/" + project_id + "/files/write",
                json={"path": "src/index.ts", "content": new_content, "side": "target"},
            )
            check(written.status_code == 200, "写入成功", "HTTP " + str(written.status_code))
            refreshed = (await client.get(base + "/api/projects/" + project_id + "/diff")).json()
            target_file = next((f for f in refreshed["files"] if f["path"] == "src/index.ts"), None)
            check(target_file is not None and "你好" in (target_file.get("patch") or ""), "差异随写入刷新")

            traversal = await client.post(
                base + "/api/projects/" + project_id + "/files/write",
                json={"path": "../../escape.ts", "content": "x", "side": "target"},
            )
            check(traversal.status_code == 400, "非法路径被拒绝", "HTTP " + str(traversal.status_code))

            print("\n=== 8. 退出登录 ===")
            await client.post(base + "/api/auth/w3/logout")
            logged_out = (await client.get(base + "/api/auth/w3/status")).json()
            check(logged_out["authenticated"] is False, "凭证已清除")

    except Exception as exc:  # noqa: BLE001
        import traceback

        print("\n" + FAIL + " 测试异常：" + str(exc))
        traceback.print_exc()
        failures.append("unexpected-exception")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        log.close()

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
