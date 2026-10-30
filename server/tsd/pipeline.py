from __future__ import annotations

import json
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from .config import SettingsStore
from .diffing import _patch_for, compute_diffs, plan_diff
from .events import EventHub, RunChannel
from .llm import LLMClient, LLMError, SYSTEM_ARCHITECT, SYSTEM_CODER
from .parser import (
    discover_code_links,
    download_source,
    fetch_text,
    html_to_markdown,
    read_plan_from_source,
    scaffold_source,
)
from .store import ProjectStore
from .utils import (
    bump_version,
    copy_tree,
    detect_version,
    has_binary_ext,
    is_important,
    language_of,
    now_ms,
    read_text,
    walk_files,
)


class Cancelled(Exception):
    pass


GOAL_SPLIT = re.compile(r"[\n；;。]+|(?:^|\s)(?:\d+[.、)]\s*)")


def extract_goals(prompt: str, limit: int = 6) -> list[str]:
    parts: list[str] = []
    for chunk in GOAL_SPLIT.split(prompt or ""):
        text = (chunk or "").strip(" -•*\t")
        if len(text) >= 4 and text not in parts:
            parts.append(text)
    if not parts:
        parts = ["梳理现有实现并明确升级边界", "按升级需求完成核心模块改造", "补充文档与回归验证"]
    return parts[:limit]


class UpgradePipeline:
    def __init__(self, store: ProjectStore, settings: SettingsStore, hub: EventHub) -> None:
        self.store = store
        self.settings = settings
        self.hub = hub
        self.llm: LLMClient | None = None

    # ------------------------------------------------------------------
    def _channel(self, run_id: str) -> RunChannel:
        channel = self.hub.get(run_id)
        if channel is None:
            channel = self.hub.create(run_id)
        return channel

    def _check_cancel(self, run: dict[str, Any]) -> None:
        if run.get("cancelRequested"):
            raise Cancelled()

    # ------------------------------------------------------------------
    def inventory(self, source: Path) -> dict[str, Any]:
        files = list(walk_files(source))
        total = len(files)
        langs = Counter(language_of(rel) for rel, _ in files if language_of(rel))
        top_dirs = Counter(rel.split("/")[0] for rel, _ in files if "/" in rel)
        important = [rel for rel, _ in files if is_important(rel)][:14]
        snippets: list[str] = []
        for rel in important[:5]:
            text, _ = read_text(source / rel, 4000)
            if not text.strip():
                continue
            snippets.append(f"### {rel}\n```\n{text[:1400].strip()}\n```")
        listing = "\n".join(f"- {rel}" for rel, _ in files[:200])
        lang_line = "、".join(f"{name} {count}" for name, count in langs.most_common(6)) or "未知"
        top_line = "、".join(f"{name}/" for name, _ in top_dirs.most_common(8)) or "（根目录）"
        text = (
            f"- 代码文件数：{total}\n"
            f"- 主要语言：{lang_line}\n"
            f"- 顶层目录：{top_line}\n"
            f"- 关键文件：{', '.join(important) if important else '无'}\n"
            f"- 文件清单（前 200 个）：\n{listing}\n"
            f"- 关键文件内容节选：\n" + "\n".join(snippets)
        )
        return {"total": total, "langs": dict(langs), "important": important, "text": text, "files": [rel for rel, _ in files]}

    # ------------------------------------------------------------------
    def offline_update_doc(
        self,
        project: dict[str, Any],
        prompt: str,
        inventory: dict[str, Any],
        mode_label: str,
    ) -> str:
        goals = extract_goals(prompt)
        base = project.get("baseVersion") or "1.0.0"
        target = project.get("targetVersion") or "1.1.0"
        lang_line = "、".join(f"{k}（{v}）" for k, v in list(inventory["langs"].items())[:5]) or "未知"
        important = "、".join(f"`{p}`" for p in inventory["important"][:8]) or "未识别到关键文件"
        lines = [
            f"# {project['name']} 升级方案：v{base} → v{target}",
            "",
            f"> 生成方式：{mode_label}  ",
            f"> 需求摘要：{prompt.strip().splitlines()[0][:120] if prompt.strip() else '按计划完成版本升级'}",
            "",
            "## 一、升级目标",
            "",
        ]
        for goal in goals:
            lines.append(f"- {goal}")
        lines += [
            "",
            "## 二、现状分析",
            "",
            "| 维度 | 结论 |",
            "| --- | --- |",
            f"| 代码规模 | {inventory['total']} 个文件 |",
            f"| 主要语言 | {lang_line} |",
            f"| 探测版本 | v{base} |",
            f"| 关键文件 | {important} |",
            "",
            "## 三、升级内容",
            "",
        ]
        for index, goal in enumerate(goals, 1):
            lines += [
                f"### 3.{index} {goal}",
                "",
                f"- **变更说明**：围绕「{goal}」调整实现，保持对外接口兼容，并同步更新相关配置与文档。",
                "- **影响范围**：核心模块、配置项、文档与回归测试。",
                "- **验收标准**：功能行为符合需求描述，旧版本关键路径可继续运行。",
                "",
            ]
        lines += [
            "## 四、兼容性与风险",
            "",
            "- 保留旧接口与配置的兼容读取逻辑，必要时通过开关降级。",
            "- 升级涉及数据结构变更时，提供迁移脚本与回滚方案。",
            "- 依赖升级前先在分支上验证关键链路，避免一次性替换全部实现。",
            "",
            "## 五、验证清单",
            "",
            "- [ ] 关键业务流程回归验证",
            "- [ ] 新增 / 调整配置项生效验证",
            "- [ ] 文档（README、部署说明）同步更新",
            "- [ ] 版本号与 CHANGELOG 已更新",
            "",
            "## 六、变更文件清单",
            "",
            "| 文件 | 类型 | 说明 |",
            "| --- | --- | --- |",
            "| 版本清单文件 | 修改 | 版本号提升到目标版本 |",
            "| CHANGELOG.md | 新增/修改 | 记录本次升级要点 |",
            "| UPGRADE_NOTES.md | 新增 | 升级说明与待办清单 |",
            "",
        ]
        return "\n".join(lines)

    # ------------------------------------------------------------------
    def offline_code_edits(
        self,
        project: dict[str, Any],
        target_dir: Path,
        prompt: str,
        update_doc: str,
        inventory: dict[str, Any],
    ) -> list[dict[str, Any]]:
        base = project.get("baseVersion") or "1.0.0"
        target = project.get("targetVersion") or "1.1.0"
        goals = extract_goals(prompt)
        # Pending edits keyed by path so several tweaks to one file merge cleanly
        # (e.g. version bump + new npm script must not clobber each other).
        pending: dict[str, dict[str, Any]] = {}

        def current_text(rel: str) -> str:
            if rel in pending:
                return pending[rel]["content"]
            path = target_dir / rel
            if path.exists():
                text, _ = read_text(path, 800_000)
                return text
            return ""

        def add(rel: str, content: str) -> None:
            before = current_text(rel)
            if before == content:
                return
            patch, additions, deletions = _patch_for(before, content, rel)
            pending[rel] = {
                "path": rel,
                "content": content,
                "before": before,
                "patch": patch,
                "additions": additions,
                "deletions": deletions,
            }

        # 1. version bump
        package_json = target_dir / "package.json"
        if package_json.exists():
            try:
                data = json.loads(current_text("package.json"))
                data["version"] = target
                add("package.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            except Exception:
                pass
        pyproject = target_dir / "pyproject.toml"
        if pyproject.exists():
            text, _ = read_text(pyproject, 200_000)
            updated = re.sub(r'(?m)^(\s*version\s*=\s*)"[^"]+"', rf'\1"{target}"', text, count=1)
            if updated != text:
                add("pyproject.toml", updated)
        pom = target_dir / "pom.xml"
        if pom.exists():
            text, _ = read_text(pom, 300_000)
            updated = re.sub(r"<version>[^<]+</version>", f"<version>{target}</version>", text, count=1)
            if updated != text:
                add("pom.xml", updated)
        cargo = target_dir / "Cargo.toml"
        if cargo.exists():
            text, _ = read_text(cargo, 200_000)
            updated = re.sub(r'(?m)^(\s*version\s*=\s*)"[^"]+"', rf'\1"{target}"', text, count=1)
            if updated != text:
                add("Cargo.toml", updated)
        gradle = target_dir / "build.gradle"
        if gradle.exists():
            text, _ = read_text(gradle, 200_000)
            updated = re.sub(r"(?m)^(\s*version\s*=?\s*)['\"][^'\"]+['\"]", rf"\1'{target}'", text, count=1)
            if updated != text:
                add("build.gradle", updated)

        # 2. migration script (language aware)
        migrate_rel = ""
        if package_json.exists():
            migrate_rel = f"scripts/migrate-v{target}.mjs"
        elif pyproject.exists() or (target_dir / "setup.py").exists():
            migrate_rel = f"scripts/migrate_v{target.replace('.', '_')}.py"
        if migrate_rel:
            if migrate_rel.endswith(".mjs"):
                migrate_body = (
                    "#!/usr/bin/env node\n"
                    f"/** 升级迁移脚本：v{base} → v{target}\n"
                    " * 由 TSD Agent 生成，请按实际数据结构补充迁移逻辑。\n"
                    " */\n\n"
                    "import process from 'node:process'\n\n"
                    "async function main() {\n"
                    f"  console.log('[migrate] v{base} -> v{target}: 开始迁移')\n"
                    "  // TODO: 实现数据结构 / 配置项迁移\n"
                    "  console.log('[migrate] 完成')\n"
                    "}\n\n"
                    "main().catch((error) => {\n"
                    "  console.error(error)\n"
                    "  process.exit(1)\n"
                    "})\n"
                )
                add(migrate_rel, migrate_body)
            else:
                migrate_body = (
                    f'"""升级迁移脚本：v{base} → v{target}\n\n'
                    "由 TSD Agent 生成，请按实际数据结构补充迁移逻辑。\n"
                    '"""\n\n'
                    "from __future__ import annotations\n\n\n"
                    "def migrate() -> None:\n"
                    f'    print("migrate v{base} -> v{target}")\n'
                    "    # TODO: 实现数据结构 / 配置项迁移\n\n\n"
                    'if __name__ == "__main__":\n'
                    "    migrate()\n"
                )
                add(migrate_rel, migrate_body)

        # add an npm script pointing at the migration helper (merged with the bump above)
        if package_json.exists() and migrate_rel.endswith(".mjs"):
            try:
                data = json.loads(current_text("package.json"))
                scripts = data.setdefault("scripts", {})
                scripts["migrate"] = f"node {migrate_rel}"
                add("package.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            except Exception:
                pass

        # 3. upgrade notes
        notes = [
            f"# 升级说明：v{base} → v{target}",
            "",
            f"生成时间：{now_ms()}",
            "",
            "## 本次升级目标",
            "",
            *[f"- {goal}" for goal in goals],
            "",
            "## 待办清单",
            "",
            "- [ ] 按升级方案逐项落地改动",
            "- [ ] 补充/更新单元测试",
            "- [ ] 更新部署配置与文档",
            "- [ ] 完成回归验证",
            "",
            "## 关联文档",
            "",
            "- 升级方案：`plan/UPDATE.md`",
            "",
        ]
        add("UPGRADE_NOTES.md", "\n".join(notes))

        # 3. changelog
        changelog_path = target_dir / "CHANGELOG.md"
        existing = current_text("CHANGELOG.md") if changelog_path.exists() else ""
        entry = [
            f"## [v{target}] - {__import__('datetime').date.today().isoformat()}",
            "",
            "### 变更",
            "",
            *[f"- {goal}" for goal in goals],
            "",
        ]
        if existing.strip():
            header = ""
            body = existing
            if existing.lstrip().startswith("# "):
                parts = existing.split("\n", 1)
                header = parts[0] + "\n\n"
                body = parts[1] if len(parts) > 1 else ""
            add("CHANGELOG.md", header + "\n".join(entry) + "\n" + body)
        else:
            add("CHANGELOG.md", "# 更新日志\n\n" + "\n".join(entry))

        # 4. README appendix
        readme = None
        for name in ("README.md", "readme.md", "README.rst"):
            if (target_dir / name).exists():
                readme = name
                break
        if readme:
            text = current_text(readme)
            appendix = [
                "",
                f"## 升级记录 v{target}",
                "",
                *[f"- {goal}" for goal in goals],
                "",
                f"> 详细的升级方案与差异请查看 `plan/UPDATE.md` 与项目差异视图。",
                "",
            ]
            if f"## 升级记录 v{target}" not in text:
                add(readme, text.rstrip() + "\n" + "\n".join(appendix))

        return list(pending.values())

    # ------------------------------------------------------------------
    def _write_edits(self, target_dir: Path, edits: list[dict[str, Any]], channel: RunChannel) -> int:
        written = 0
        for edit in edits:
            rel = str(edit.get("path") or "").strip().lstrip("./")
            content = edit.get("content")
            if not rel or not isinstance(content, str):
                continue
            if rel.startswith("/") or ".." in Path(rel).parts:
                channel.log(f"忽略非法路径：{rel}", "warn")
                continue
            if has_binary_ext(rel):
                channel.log(f"跳过二进制文件：{rel}", "warn")
                continue
            if len(content.encode("utf-8")) > 400_000:
                channel.log(f"跳过超大文件：{rel}", "warn")
                continue
            path = target_dir / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, "utf-8")
            written += 1
        return written

    # ------------------------------------------------------------------
    async def run(
        self,
        project: dict[str, Any],
        run: dict[str, Any],
        prompt: str,
        target_version: str | None = None,
        reference_url: str | None = None,
    ) -> None:
        channel = self._channel(run["id"])
        run["status"] = "running"
        run["prompt"] = prompt
        self.store.save_run(run)
        channel.emit("run.status", data={"status": "running"})

        engine = self.settings.engine()
        self.llm = LLMClient(engine)
        online = self.llm.available()
        run["model"] = self.llm.model if online else "离线启发式"
        self.store.save_run(run)
        channel.log(f"模型：{run['model']}（{'在线' if online else '离线降级'}）")
        if not online:
            channel.log("未配置 API Key 或已开启离线模式，将使用内置规则生成方案与改动", "warn")

        paths = self.store.paths(project["id"])
        source_dir = paths["source"]
        plan_text = ""
        update_doc = ""
        inventory: dict[str, Any] = {"total": 0, "langs": {}, "important": [], "text": "", "files": []}
        code_notes: list[str] = []

        try:
            # ---------------- STEP 1: 解析方案 ----------------
            channel.step_status("fetch", title="解析方案页面", status="running", detail="抓取页面并提取结构化内容")
            kind = project.get("sourceKind") or "page"
            source_url = project.get("sourceUrl") or ""
            discovered: list[str] = []
            if kind == "page" and source_url.startswith("http"):
                channel.log(f"抓取方案页面：{source_url}")
                try:
                    text, content_type, final_url = await fetch_text(source_url)
                    self._check_cancel(run)
                    if "html" in content_type or "<html" in text[:500].lower():
                        plan_text = html_to_markdown(text, final_url)
                        discovered = discover_code_links(text, final_url)
                        if discovered:
                            channel.log(f"发现候选代码来源：{discovered[0]}")
                    else:
                        plan_text = text
                    if not plan_text.strip():
                        raise ValueError("页面内容为空")
                    paths["plan"].parent.mkdir(parents=True, exist_ok=True)
                    header = f"<!-- source: {final_url} -->\n\n"
                    paths["plan"].write_text(header + plan_text, "utf-8")
                    channel.emit("plan.ready", data={"path": str(paths["plan"]), "chars": len(plan_text)})
                    channel.step_status(
                        "fetch",
                        status="done",
                        detail=f"已解析 {len(plan_text)} 字符",
                        metrics={"字符": len(plan_text)},
                    )
                    channel.log(f"方案解析完成，共 {len(plan_text)} 字符", "success")
                except Exception as exc:  # noqa: BLE001
                    channel.log(f"页面解析失败：{exc}", "error")
                    channel.step_status("fetch", status="failed", detail=str(exc)[:200])
                    plan_text = f"# {project['name']}\n\n> 方案页面解析失败：{exc}\n"
                    paths["plan"].parent.mkdir(parents=True, exist_ok=True)
                    paths["plan"].write_text(plan_text, "utf-8")
            else:
                channel.log("方案来源不是网页，将在下载代码后从仓库文档生成初始方案")
                channel.step_status("fetch", status="skipped", detail="使用仓库自带文档作为初始方案")

            self._check_cancel(run)

            # ---------------- STEP 2: 下载代码 ----------------
            channel.step_status("download", title="下载基础代码", status="running", detail="准备代码目录")
            code_url = reference_url or (source_url if kind in {"git", "zip", "local"} else (discovered[0] if discovered else None))
            download_result: dict[str, Any] = {"ok": False, "files": 0, "method": "none", "note": ""}
            if code_url:
                channel.log(f"代码来源：{code_url}")
                channel.step_status("download", status="running", detail=f"正在获取 {code_url[:80]}", progress=10)
                download_result = await download_source(
                    "local" if kind == "local" else ("zip" if code_url.lower().endswith(".zip") else "git"),
                    code_url,
                    source_dir,
                    lambda msg, level="info": channel.log(msg, level),
                )
                channel.step_status(
                    "download",
                    status="done" if download_result["ok"] else "failed",
                    detail=download_result["note"] or "完成",
                    progress=100,
                    metrics={"文件": download_result["files"]},
                )
            else:
                channel.log("未找到代码来源，生成项目骨架以便后续流程继续", "warn")
                channel.step_status("download", status="skipped", detail="无代码来源，使用脚手架")

            if not source_dir.exists() or not any(source_dir.iterdir()):
                generated_plan = plan_text or f"# {project['name']}\n"
                scaffold_source(source_dir, project["name"], generated_plan, source_url)
                download_result = {"ok": True, "files": 3, "method": "scaffold", "note": "已生成项目骨架"}
                channel.log("已生成最小项目骨架", "warn")

            self._check_cancel(run)

            # 方案兜底（仓库类来源）
            if not paths["plan"].exists() or not plan_text.strip():
                plan_text = read_plan_from_source(source_dir)
                paths["plan"].parent.mkdir(parents=True, exist_ok=True)
                paths["plan"].write_text(plan_text, "utf-8")
                channel.emit("plan.ready", data={"path": str(paths["plan"]), "chars": len(plan_text)})
                channel.log("已从仓库文档生成初始方案")

            # 版本探测
            detected = detect_version(source_dir)
            if detected:
                project["baseVersion"] = detected
                explicit_target = (target_version or project.get("targetVersion") or "").strip()
                if not explicit_target or explicit_target == "1.1.0":
                    project["targetVersion"] = bump_version(detected, "minor")
                channel.log(f"探测到项目版本 v{detected}")
            if target_version:
                project["targetVersion"] = target_version
            project["status"] = "running"
            self.store.save(project)
            target_dir = self.store.target_dir(project)
            channel.log(f"目标版本：v{project['targetVersion']} → {target_dir.name}")

            # ---------------- STEP 3: 分析结构 ----------------
            channel.step_status("analyze", title="分析项目结构", status="running", detail="扫描文件与依赖")
            inventory = self.inventory(source_dir)
            channel.log(f"扫描到 {inventory['total']} 个代码文件", "info")
            channel.step_status(
                "analyze",
                status="done",
                detail=f"{inventory['total']} 个文件",
                metrics={"文件": inventory["total"], "语言": len(inventory["langs"])},
            )
            self._check_cancel(run)

            # ---------------- STEP 4: 生成 UPDATE.md ----------------
            channel.step_status("update", title="生成升级方案", status="running", detail="撰写 UPDATE.md")
            mode_label = f"{self.llm.model} 在线生成" if online else "离线启发式规则"
            if online and self.llm:
                channel.log("调用模型生成升级方案…")
                try:
                    update_doc = await self._llm_update_doc(project, prompt, plan_text, inventory)
                except LLMError as exc:
                    channel.log(f"模型生成失败，降级离线模板：{exc}", "warn")
                    update_doc = self.offline_update_doc(project, prompt, inventory, "离线启发式（模型不可用）")
            else:
                update_doc = self.offline_update_doc(project, prompt, inventory, mode_label)
            self._check_cancel(run)
            paths["update"].parent.mkdir(parents=True, exist_ok=True)
            paths["update"].write_text(update_doc, "utf-8")
            channel.emit("plan.ready", data={"path": str(paths["update"]), "chars": len(update_doc)})
            channel.step_status(
                "update",
                status="done",
                detail=f"已生成 {len(update_doc)} 字符",
                metrics={"章节": len(re.findall(r"(?m)^##\s+", update_doc))},
            )
            channel.log("UPDATE.md 已生成", "success")

            # ---------------- STEP 5: 升级代码 ----------------
            channel.step_status("code", title="升级代码", status="running", detail="复制基础代码并应用改动")
            if target_dir.exists():
                shutil.rmtree(target_dir, ignore_errors=True)
            copied = copy_tree(source_dir, target_dir)
            channel.log(f"已复制 {copied} 个文件到 v{project['targetVersion']} 目录")

            edits: list[dict[str, Any]] = []
            if online and self.llm:
                channel.log("请求模型产出代码改动…")
                try:
                    payload = await self._llm_code_edits(project, prompt, update_doc, inventory)
                    edits = payload.get("edits", [])
                    if edits:
                        channel.log(f"模型给出 {len(edits)} 个文件改动")
                    else:
                        channel.log("模型未返回改动，使用离线规则", "warn")
                except LLMError as exc:
                    channel.log(f"模型改动请求失败：{exc}", "warn")
            if not edits:
                edits = self.offline_code_edits(project, target_dir, prompt, update_doc, inventory)
                channel.log(f"应用离线规则生成 {len(edits)} 个文件改动")

            written = self._write_edits(target_dir, edits, channel)
            code_notes = [str(e.get("path")) for e in edits if e.get("path")]
            channel.step_status(
                "code",
                status="done",
                detail=f"写入 {written} 个文件",
                metrics={"改动文件": written},
            )
            channel.log(f"代码升级完成，共写入 {written} 个文件", "success")
            self._check_cancel(run)

            # ---------------- STEP 6: 差异 ----------------
            channel.step_status("diff", title="计算差异", status="running", detail="逐文件生成统一差异")
            file_diffs = compute_diffs(source_dir, target_dir)
            doc_diff = plan_diff(plan_text, update_doc)
            diff_payload = {
                "projectId": project["id"],
                "generatedAt": now_ms(),
                "plan": doc_diff,
                "files": file_diffs["files"],
                "stats": file_diffs["stats"],
            }
            paths["diff"].write_text(json.dumps(diff_payload, ensure_ascii=False), "utf-8")
            channel.emit("diff.ready", data={"files": file_diffs["stats"]["filesChanged"]})
            channel.step_status(
                "diff",
                status="done",
                detail=f"{file_diffs['stats']['filesChanged']} 个文件变更",
                metrics={"新增行": file_diffs["stats"]["added"], "删除行": file_diffs["stats"]["removed"]},
            )

            # ---------------- STEP 7: 收尾 ----------------
            channel.step_status("finalize", title="整理结果", status="running", detail="写入项目元数据")
            sections = len([s for s in doc_diff["sections"] if s.get("status") != "unchanged"])
            project.update(
                {
                    "status": "ready",
                    "lastRunId": run["id"],
                    "stats": {
                        "files": file_diffs["stats"]["files"],
                        "added": file_diffs["stats"]["added"],
                        "removed": file_diffs["stats"]["removed"],
                        "sections": sections,
                        "filesChanged": file_diffs["stats"]["filesChanged"],
                    },
                }
            )
            self.store.save(project)
            channel.step_status("finalize", status="done", detail="完成")

            usage = self.llm.usage if self.llm else {}
            if usage:
                channel.emit("run.metrics", data={"usage": usage, "model": run["model"]})
            summary = (
                f"已生成 v{project['targetVersion']}：{file_diffs['stats']['filesChanged']} 个文件变更，"
                f"+{file_diffs['stats']['added']} / -{file_diffs['stats']['removed']} 行，方案变更 {sections} 段。"
            )
            run.update(
                {
                    "status": "done",
                    "finishedAt": now_ms(),
                    "summary": summary,
                    "usage": usage,
                }
            )
            self.store.save_run(run)
            channel.emit("run.done", data={"summary": summary, "status": "done"})
            channel.log(summary, "success")
            channel.close()

        except Cancelled:
            project["status"] = "draft"
            self.store.save(project)
            run.update({"status": "cancelled", "finishedAt": now_ms(), "summary": "任务已取消"})
            self.store.save_run(run)
            channel.log("任务已取消", "warn")
            channel.emit("run.done", data={"status": "cancelled", "summary": "任务已取消"})
            channel.close()
        except Exception as exc:  # noqa: BLE001
            import traceback

            project["status"] = "failed"
            project["error"] = str(exc)[:400]
            self.store.save(project)
            run.update({"status": "failed", "finishedAt": now_ms(), "error": str(exc)[:800]})
            self.store.save_run(run)
            channel.log(f"执行失败：{exc}", "error")
            channel.log(traceback.format_exc()[-1200:], "debug")
            channel.emit("run.error", message=str(exc)[:400])
            channel.close()

    # ------------------------------------------------------------------
    async def _llm_update_doc(
        self,
        project: dict[str, Any],
        prompt: str,
        plan_text: str,
        inventory: dict[str, Any],
    ) -> str:
        assert self.llm is not None
        messages = [
            {"role": "system", "content": SYSTEM_ARCHITECT},
            {
                "role": "user",
                "content": (
                    f"请为项目「{project['name']}」编写升级方案文档，版本 v{project.get('baseVersion')} → "
                    f"v{project.get('targetVersion')}。\n\n"
                    f"## 用户升级需求\n{prompt.strip()[:4000]}\n\n"
                    f"## 原始方案（节选）\n{plan_text[:5000]}\n\n"
                    f"## 代码库扫描结果\n{inventory['text'][:3500]}\n\n"
                    "## 输出要求\n"
                    "输出完整的 Markdown 文档，不要使用代码围栏包裹整篇文档。必须包含这些二级标题：\n"
                    "## 一、升级目标\n## 二、现状分析\n## 三、升级内容\n## 四、兼容性与风险\n## 五、验证清单\n## 六、变更文件清单\n"
                    "「三、升级内容」按要点分小节，每节说明变更点、影响文件与验收标准。"
                    "「六、变更文件清单」用 Markdown 表格列出预计改动的文件与类型。"
                ),
            },
        ]
        return await self.llm.chat(messages, max_tokens=min(self.llm.max_tokens, 6000), temperature=0.25)

    async def _llm_code_edits(
        self,
        project: dict[str, Any],
        prompt: str,
        update_doc: str,
        inventory: dict[str, Any],
    ) -> dict[str, Any]:
        assert self.llm is not None
        file_list = "\n".join(inventory["files"][:220])
        messages = [
            {"role": "system", "content": SYSTEM_CODER},
            {
                "role": "user",
                "content": (
                    f"项目：{project['name']}\n目标版本：v{project.get('targetVersion')}\n\n"
                    f"## 升级需求\n{prompt.strip()[:3000]}\n\n"
                    f"## 升级方案（节选）\n{update_doc[:3500]}\n\n"
                    f"## 代码库概况\n{inventory['text'][:2500]}\n\n"
                    f"## 可修改文件\n{file_list}\n\n"
                    "## 任务\n"
                    "基于升级方案，产出 1-6 个文件的最终内容（可以是新文件，例如 docs/UPGRADE_NOTES.md、"
                    "迁移脚本或测试）。只修改与需求直接相关的实现，保持项目原有风格。\n"
                    "输出严格 JSON：\n"
                    '{"summary":"一句话总结","rationale":"简短说明",'
                    '"edits":[{"path":"相对路径","content":"完整文件内容","reason":"修改原因"}]}'
                ),
            },
        ]
        payload = await self.llm.chat_json(messages, max_tokens=min(self.llm.max_tokens, 8000), temperature=0.2)
        if not payload:
            raise LLMError("模型未返回可解析的 JSON")
        raw_edits = payload.get("edits")
        edits: list[dict[str, Any]] = []
        if isinstance(raw_edits, list):
            for item in raw_edits[:8]:
                if not isinstance(item, dict):
                    continue
                path = str(item.get("path") or "").strip()
                content = item.get("content")
                if path and isinstance(content, str):
                    edits.append({"path": path, "content": content, "reason": item.get("reason", "")})
        return {"summary": payload.get("summary", ""), "edits": edits}
