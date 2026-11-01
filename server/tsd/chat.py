from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Any

from .chat_agent import SYSTEM_CHAT_AGENT, StreamingChatAgent, build_chat_messages
from .config import SettingsStore
from .diffing import _patch_for
from .events import EventHub, RunChannel
from .llm import LLMClient, LLMError
from .store import ProjectStore
from .utils import has_binary_ext, now_ms, read_text, walk_files

PATH_RE = re.compile(r"[\w./-]+\.(?:py|js|jsx|ts|tsx|java|go|rs|c|cpp|h|cs|rb|php|kt|swift|vue|svelte|json|ya?ml|toml|md|css|scss|html|sql|sh)")

SYSTEM_CHAT = (
    "你是 TSD Agent 的项目升级助手，已完整阅读项目的原始方案、升级方案与升级后的代码库。"
    "用户会要求你继续修改代码或方案，你需要给出可以直接落盘的完整文件内容。"
    "只输出 JSON，不要输出 Markdown 围栏或额外解释。"
)


class ChatAgent:
    def __init__(self, store: ProjectStore, settings: SettingsStore, hub: EventHub) -> None:
        self.store = store
        self.settings = settings
        self.hub = hub

    def _channel(self, run_id: str) -> RunChannel:
        channel = self.hub.get(run_id)
        if channel is None:
            channel = self.hub.create(run_id)
        return channel

    # ------------------------------------------------------------------
    def _context(self, project: dict[str, Any], message: str) -> dict[str, Any]:
        paths = self.store.paths(project["id"])
        target_dir = self.store.target_dir(project)
        plan, _ = read_text(paths["plan"], 200_000)
        update, _ = read_text(paths["update"], 200_000)
        diff_note = ""
        diff_path = paths["diff"]
        if diff_path.exists():
            try:
                import json

                data = json.loads(diff_path.read_text("utf-8"))
                stats = data.get("stats", {})
                diff_note = (
                    f"当前差异：{stats.get('filesChanged', 0)} 个文件变更，"
                    f"+{stats.get('added', 0)} / -{stats.get('removed', 0)} 行。"
                )
            except Exception:
                pass

        files = [rel for rel, _ in walk_files(target_dir)] if target_dir.exists() else []
        mentioned: list[str] = []
        for match in PATH_RE.finditer(message or ""):
            candidate = match.group(0).lstrip("./")
            for rel in files:
                if rel.endswith(candidate) or candidate.endswith(rel):
                    if rel not in mentioned:
                        mentioned.append(rel)
                    break
        mentioned = mentioned[:3]

        snippets: list[str] = []
        for rel in mentioned:
            text, truncated = read_text(target_dir / rel, 60_000)
            if truncated:
                text = text[:6000]
            snippets.append(f"### {rel}\n```\n{text[:6000]}\n```")

        return {
            "target_dir": target_dir,
            "plan": plan,
            "update": update,
            "files": files,
            "mentioned": mentioned,
            "snippets": snippets,
            "diff_note": diff_note,
        }

    # ------------------------------------------------------------------
    def _make_edit(
        self, target_dir: Path, rel: str, content: str, reason: str = ""
    ) -> dict[str, Any] | None:
        """把「完整文件内容」变成可审阅的补丁；路径非法返回 None。"""
        rel = str(rel or "").strip().lstrip("./")
        if not rel or not isinstance(content, str):
            return None
        if rel.startswith("/") or ".." in Path(rel).parts or has_binary_ext(rel):
            return None
        path = target_dir / rel
        before = ""
        if path.exists():
            before, _ = read_text(path, 600_000)
        patch, additions, deletions = _patch_for(before, content, rel)
        return {
            "path": rel,
            "before": before,
            "after": content,
            "patch": patch,
            "additions": additions,
            "deletions": deletions,
            "reason": reason,
        }

    async def _streaming_agent_turn(
        self,
        project: dict[str, Any],
        channel: RunChannel,
        llm: LLMClient,
        ctx: dict[str, Any],
        message: str,
        history: list[dict[str, str]] | None,
    ) -> dict[str, Any] | None:
        """流式 + 工具调用的一轮对话。模型/网关不支持流式时返回 None 交给上层降级。"""
        file_list = "\n".join(ctx["files"][:200])
        context = (
            "## 项目背景（一次性提供，之后你可以用工具自查）\n"
            f"- 项目：{project['name']}（v{project.get('baseVersion')} → v{project.get('targetVersion')}）\n"
            f"- {ctx['diff_note'] or '尚无差异统计'}\n\n"
            f"### 升级方案（节选）\n{ctx['update'][:3000]}\n\n"
            f"### 原始方案（节选）\n{ctx['plan'][:1200]}\n\n"
            f"### 代码库文件（前 200 个）\n{file_list}"
        )
        turns = list(history or [])
        turns.append({"role": "user", "content": message.strip()})
        messages = build_chat_messages(SYSTEM_CHAT_AGENT, turns, context)
        target_dir = ctx["target_dir"]

        async def make_edit(rel: str, body: str, reason: str) -> dict[str, Any] | None:
            return self._make_edit(target_dir, rel, body, reason)

        agent = StreamingChatAgent(llm, channel, target_dir, make_edit=make_edit)
        try:
            turn = await agent.run(messages)
        except LLMError as exc:
            if str(exc) == "stream-unsupported":
                channel.log("模型不支持流式输出，退回非流式对话", "warn")
                return None
            raise
        if not turn.reply.strip() and not turn.edits:
            return None
        channel.log(
            f"流式对话完成：{turn.rounds} 轮 / {turn.tool_calls} 次工具调用 / {len(turn.edits)} 个改动建议",
            "success",
        )
        return {
            "reply": turn.reply.strip() or ("已准备好 " + str(len(turn.edits)) + " 个改动建议，请在下方审阅。"),
            "summary": "对话修改建议" if turn.edits else "对话回答",
            "rationale": "",
            "edits": turn.edits,
            "streamed": True,
            "reasoning": turn.reasoning,
        }

    # ------------------------------------------------------------------
    def _offline_reply(self, project: dict[str, Any], message: str, ctx: dict[str, Any]) -> dict[str, Any]:
        files = ctx["files"]
        mentioned = ctx["mentioned"]
        lines = [
            "**当前为离线模式**，未配置模型 API Key，因此我只能给出分析建议，无法直接生成代码补丁。",
            "",
            f"- 项目：{project['name']}（v{project.get('targetVersion')}）",
            f"- 已索引文件：{len(files)} 个",
        ]
        if mentioned:
            lines.append(f"- 你提到的文件：{', '.join(f'`{p}`' for p in mentioned)}")
        if ctx["diff_note"]:
            lines.append(f"- {ctx['diff_note']}")
        lines += [
            "",
            "建议在「设置 → 推理引擎」中填入 API Key 后重试，即可直接对话修改代码并生成可应用的补丁。",
        ]
        edits: list[dict[str, Any]] = []
        # 唯一确定性的离线动作：把需求追加到 UPGRADE_NOTES.md
        notes_rel = "UPGRADE_NOTES.md"
        if ctx["target_dir"].exists():
            path = ctx["target_dir"] / notes_rel
            before = ""
            if path.exists():
                before, _ = read_text(path, 400_000)
            addition = f"\n## 追加需求（{now_ms()}）\n\n{message.strip()}\n"
            after = (before.rstrip() + addition) if before.strip() else ("# 升级说明\n" + addition)
            if after != before:
                patch, additions, deletions = _patch_for(before, after, notes_rel)
                edits.append(
                    {
                        "path": notes_rel,
                        "before": before,
                        "after": after,
                        "patch": patch,
                        "additions": additions,
                        "deletions": deletions,
                        "reason": "离线模式：记录追加需求",
                    }
                )
                lines += ["", "我已把你这条需求追加到 `UPGRADE_NOTES.md`（可在下方一键应用）。"]
        return {"reply": "\n".join(lines), "summary": "记录追加需求", "rationale": "离线模式下的确定性改动", "edits": edits}

    # ------------------------------------------------------------------
    async def run(
        self,
        project: dict[str, Any],
        run: dict[str, Any],
        message: str,
        history: list[dict[str, str]] | None = None,
    ) -> None:
        channel = self._channel(run["id"])
        channel.attach_run(run, self.store.save_run)
        run["status"] = "running"
        self.store.save_run(run)
        channel.emit("run.status", data={"status": "running"})

        llm = LLMClient(self.settings.engine())
        online = llm.available()
        channel.log(f"对话模型：{llm.model if online else '离线模式'}")
        reply_text = ""

        try:
            channel.step_status("context", title="读取项目上下文", status="running", detail="加载方案与代码索引")
            ctx = self._context(project, message)
            channel.log(f"上下文：{len(ctx['files'])} 个文件，引用 {len(ctx['mentioned'])} 个文件")
            channel.step_status(
                "context",
                status="done",
                detail=f"索引 {len(ctx['files'])} 个文件",
                metrics={"文件": len(ctx["files"])},
            )

            channel.step_status("reason", title="理解修改需求", status="running", detail="分析需求与影响范围")
            payload: dict[str, Any] | None = None
            if online:
                # 首选：流式 + 工具调用（思考过程、看代码、给提案都在这一条链路里）
                try:
                    payload = await self._streaming_agent_turn(project, channel, llm, ctx, message, history)
                except LLMError as exc:
                    channel.log(f"流式对话失败，改用非流式：{exc}", "warn")
                    payload = None
            if online and payload is None:
                file_list = "\n".join(ctx["files"][:200])
                snippets = "\n".join(ctx["snippets"]) or "（未指定具体文件）"
                messages = [
                    {"role": "system", "content": SYSTEM_CHAT},
                    {
                        "role": "user",
                        "content": (
                            f"项目：{project['name']}（v{project.get('baseVersion')} → v{project.get('targetVersion')}）\n"
                            f"{ctx['diff_note']}\n\n"
                            f"## 升级方案（节选）\n{ctx['update'][:3500]}\n\n"
                            f"## 原始方案（节选）\n{ctx['plan'][:1500]}\n\n"
                            f"## 代码库文件（前 200 个）\n{file_list}\n\n"
                            f"## 用户提到的文件内容\n{snippets}\n\n"
                            f"## 用户消息\n{message.strip()}\n\n"
                            "请回答用户，并在必要时给出完整文件改动。输出严格 JSON：\n"
                            '{"reply":"给用户的回答（Markdown，简明）",'
                            '"summary":"一句话改动摘要","rationale":"为什么这样改",'
                            '"edits":[{"path":"相对路径","content":"完整文件内容","reason":"原因"}]}'
                            "\n如果只是回答问题无需改代码，edits 输出空数组。"
                        ),
                    },
                ]
                try:
                    parsed = await llm.chat_json(messages, max_tokens=min(llm.max_tokens, 6000), temperature=0.25)
                    if not parsed:
                        raise LLMError("模型未返回可解析 JSON")
                    raw_edits = parsed.get("edits") if isinstance(parsed.get("edits"), list) else []
                    edits: list[dict[str, Any]] = []
                    for item in raw_edits[:6]:
                        if not isinstance(item, dict):
                            continue
                        rel = str(item.get("path") or "").strip().lstrip("./")
                        content = item.get("content")
                        if not rel or not isinstance(content, str):
                            continue
                        if rel.startswith("/") or ".." in Path(rel).parts or has_binary_ext(rel):
                            continue
                        path = ctx["target_dir"] / rel
                        before = ""
                        if path.exists():
                            before, _ = read_text(path, 600_000)
                        patch, additions, deletions = _patch_for(before, content, rel)
                        edits.append(
                            {
                                "path": rel,
                                "before": before,
                                "after": content,
                                "patch": patch,
                                "additions": additions,
                                "deletions": deletions,
                                "reason": item.get("reason", ""),
                            }
                        )
                    payload = {
                        "reply": str(parsed.get("reply") or "").strip() or "已更新代码，请查看下方改动建议。",
                        "summary": str(parsed.get("summary") or "").strip() or "代码调整",
                        "rationale": str(parsed.get("rationale") or "").strip(),
                        "edits": edits,
                    }
                except LLMError as exc:
                    channel.log(f"模型调用失败，降级离线回复：{exc}", "warn")
                    payload = None
            if not payload:
                payload = self._offline_reply(project, message, ctx)

            reply_text = payload["reply"]
            channel.step_status("reason", status="done", detail="已生成回复")

            channel.step_status("patch", title="生成修改建议", status="running", detail="构造可应用补丁")
            if not payload.get("streamed"):
                # 非流式 / 离线路径：把完整回复切成小块推给前端，保持「逐字出现」的观感
                for index in range(0, len(reply_text), 36):
                    channel.emit("chat.delta", delta=reply_text[index : index + 36])
                    await asyncio.sleep(0.012)

            proposal = None
            edits = payload.get("edits") or []
            if edits:
                proposal_id = uuid.uuid4().hex[:10]
                proposal = {
                    "id": proposal_id,
                    "summary": payload.get("summary") or "代码调整",
                    "rationale": payload.get("rationale") or "",
                    "edits": edits,
                    "createdAt": now_ms(),
                    "applied": False,
                }
                proposals = self.store.proposals(project["id"])
                proposals[proposal_id] = proposal
                self.store.save_proposals(project["id"], proposals)
                channel.log(f"生成 {len(edits)} 个文件的修改建议", "success")
            else:
                channel.log("本次回复未包含代码改动")

            channel.step_status(
                "patch",
                status="done" if edits else "skipped",
                detail=f"{len(edits)} 个文件" if edits else "无需改动",
            )
            channel.emit(
                "chat.message",
                data={
                    "content": reply_text,
                    "proposal": proposal,
                    "summary": payload.get("summary"),
                },
            )
            run.update(
                {
                    "status": "done",
                    "finishedAt": now_ms(),
                    "summary": payload.get("summary") or "对话完成",
                    "usage": llm.usage if online else {},
                }
            )
            self.store.save_run(run)
            channel.emit("run.done", data={"summary": run["summary"], "status": "done"})
            channel.close()
        except Exception as exc:  # noqa: BLE001
            import traceback

            run.update({"status": "failed", "finishedAt": now_ms(), "error": str(exc)[:600]})
            self.store.save_run(run)
            channel.log(f"对话失败：{exc}", "error")
            channel.log(traceback.format_exc()[-1000:], "debug")
            channel.emit("chat.message", data={"content": reply_text, "error": str(exc)[:300]})
            channel.emit("run.error", message=str(exc)[:300])
            channel.close()
