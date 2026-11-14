//! 升级流水线（L2 的无模型版本）：7 步全部真实执行，产出与 Python 参照实现同构的文件。
//!
//! 与 Python 版的差别只在「改动内容」：这里不调用模型，走确定性的离线改动
//! （版本号、CHANGELOG、UPGRADE_NOTES、README 记录）。L3/L5 接入模型后替换 code/update 两步。

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};

use crate::{
    diff, events::now_ms, runs, runs::Run, state::AppState,
};

pub struct Pipeline {
    pub state: Arc<AppState>,
    pub channel: Arc<crate::events::RunChannel>,
    pub run: Run,
    pub cancel: Arc<AtomicBool>,
}

impl Pipeline {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn emit_step(&mut self, key: &str, status: &str, detail: Option<String>, progress: Option<u32>, metrics: Option<Value>) {
        self.run.set_step(key, status, detail.clone(), metrics.clone(), progress);
        let title = self
            .run
            .steps
            .iter()
            .find(|step| step.key == key)
            .map(|step| step.title.clone())
            .unwrap_or_else(|| key.to_string());
        let started_at = self.run.steps.iter().find(|s| s.key == key).and_then(|s| s.started_at);
        let finished_at = self.run.steps.iter().find(|s| s.key == key).and_then(|s| s.finished_at);
        let mut data = json!({
            "key": key,
            "title": title,
            "status": status,
        });
        if let Some(detail) = detail.clone() {
            data["detail"] = json!(detail);
        }
        if let Some(progress) = progress {
            data["progress"] = json!(progress);
        }
        if let Some(metrics) = metrics {
            data["metrics"] = metrics;
        }
        if let Some(started_at) = started_at {
            data["startedAt"] = json!(started_at);
        }
        if let Some(finished_at) = finished_at {
            data["finishedAt"] = json!(finished_at);
        }
        self.channel.emit_full(
            "step.status",
            Some(key.to_string()),
            None,
            detail,
            None,
            Some(data),
        );
        // 步骤状态立刻写回 run.json：刷新页面读的是它
        let project_dir = self.state.project_dir(&self.run.project_id);
        let _ = runs::save_run(&project_dir, &self.run);
    }

    fn fail(&mut self, step: &str, message: &str) {
        self.emit_step(step, "failed", Some(message.to_string()), None, None);
        self.channel.log("error", message, Some(step));
        self.run.status = "failed".to_string();
        self.run.error = Some(message.to_string());
        self.run.finished_at = Some(now_ms());
        let project_dir = self.state.project_dir(&self.run.project_id);
        let _ = runs::save_run(&project_dir, &self.run);
        self.channel.emit("run.error", Some(json!({ "message": message })));
    }

    pub async fn run_upgrade(
        mut self,
        project: Value,
        prompt: String,
        target_version: String,
    ) -> Value {
        let project_id = project.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let project_dir = self.state.project_dir(&project_id);
        let source_dir = project_dir.join("source");
        let target_dir = project_dir.join(format!("v{}", target_version));
        let plan_path = project_dir.join("plan").join("PLAN.md");
        let update_path = project_dir.join("plan").join("UPDATE.md");

        self.channel.log("info", "任务已创建，开始执行升级流水线", None);

        // ---------------- 1. fetch ----------------
        self.emit_step("fetch", "running", Some("解析方案页面".to_string()), Some(5), None);
        if self.stopped() {
            return self.finish_cancelled("fetch");
        }
        let plan_text = match fetch_plan(&project, &plan_path) {
            Ok(text) => text,
            Err(error) => {
                self.fail("fetch", &error);
                return json!({ "status": "failed" });
            }
        };
        let plan_chars = plan_text.chars().count();
        self.channel.log("info", &format!("方案已解析：{} 字符", plan_chars), Some("fetch"));
        self.emit_step(
            "fetch",
            "done",
            Some(format!("已解析 {} 字符", plan_chars)),
            Some(15),
            Some(json!({ "字符": plan_chars })),
        );

        // ---------------- 2. download ----------------
        self.emit_step("download", "running", Some("准备代码".to_string()), Some(18), None);
        if self.stopped() {
            return self.finish_cancelled("download");
        }
        let file_count = match prepare_source(&project, &source_dir) {
            Ok(count) => count,
            Err(error) => {
                self.fail("download", &error);
                return json!({ "status": "failed" });
            }
        };
        self.channel.log("info", &format!("代码就绪：{} 个文件", file_count), Some("download"));
        self.emit_step(
            "download",
            "done",
            Some(format!("{} 个文件", file_count)),
            Some(35),
            Some(json!({ "文件": file_count })),
        );

        // ---------------- 3. analyze ----------------
        self.emit_step("analyze", "running", Some("分析项目结构".to_string()), Some(40), None);
        if self.stopped() {
            return self.finish_cancelled("analyze");
        }
        let inventory = analyze(&source_dir);
        self.channel.log("info", &inventory.log_line, Some("analyze"));
        self.emit_step(
            "analyze",
            "done",
            Some(inventory.summary.clone()),
            Some(50),
            Some(json!({ "文件": inventory.total, "语言": inventory.top_languages.len() })),
        );

        // ---------------- 4. update ----------------
        self.emit_step("update", "running", Some("生成升级方案".to_string()), Some(55), None);
        if self.stopped() {
            return self.finish_cancelled("update");
        }
        let update_doc = build_update_doc(&project, &prompt, &plan_text, &inventory);
        let _ = fs::create_dir_all(update_path.parent().unwrap_or(Path::new(".")));
        let _ = fs::write(&update_path, &update_doc);
        self.channel.emit(
            "artifact",
            Some(json!({ "kind": "plan", "path": update_path.to_string_lossy(), "label": "升级方案" })),
        );
        self.channel.emit(
            "plan.ready",
            Some(json!({ "path": update_path.to_string_lossy(), "chars": update_doc.chars().count() })),
        );
        self.emit_step(
            "update",
            "done",
            Some(format!("方案 {} 字符", update_doc.chars().count())),
            Some(65),
            None,
        );

        // ---------------- 5. code ----------------
        self.emit_step("code", "running", Some("按方案改造代码".to_string()), Some(70), None);
        if self.stopped() {
            return self.finish_cancelled("code");
        }
        let changed = match apply_changes(&source_dir, &target_dir, &project, &prompt, &plan_text) {
            Ok(changed) => changed,
            Err(error) => {
                self.fail("code", &error);
                return json!({ "status": "failed" });
            }
        };
        self.channel.log("info", &format!("离线改动完成：{} 个文件", changed), Some("code"));
        self.emit_step(
            "code",
            "done",
            Some(format!("改动 {} 个文件", changed)),
            Some(82),
            Some(json!({ "改动文件": changed })),
        );

        // ---------------- 6. diff ----------------
        self.emit_step("diff", "running", Some("计算差异".to_string()), Some(85), None);
        if self.stopped() {
            return self.finish_cancelled("diff");
        }
        let file_diffs = diff::compute_diffs(&source_dir, &target_dir);
        let plan_diff = diff::plan_diff(&plan_text, &update_doc);
        let payload = json!({
            "projectId": project_id,
            "generatedAt": now_ms(),
            "plan": plan_diff,
            "files": file_diffs.files,
            "stats": file_diffs.stats,
        });
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = fs::write(project_dir.join("diff.json"), text);
        }
        let files_changed = payload["stats"]["filesChanged"].as_u64().unwrap_or(0);
        self.channel.emit("diff.ready", Some(json!({ "files": files_changed })));
        self.emit_step(
            "diff",
            "done",
            Some(format!("{} 个文件变更", files_changed)),
            Some(95),
            Some(json!({ "变更文件": files_changed })),
        );

        // ---------------- 7. finalize ----------------
        self.emit_step("finalize", "running", Some("整理结果".to_string()), Some(96), None);
        let mut updated = project.clone();
        if let Some(object) = updated.as_object_mut() {
            object.insert("status".to_string(), json!("ready"));
            object.insert("updatedAt".to_string(), json!(now_ms()));
            object.insert("lastRunId".to_string(), json!(self.run.id));
            object.insert(
                "stats".to_string(),
                json!({
                    "files": file_diffs.stats.files,
                    "added": file_diffs.stats.added,
                    "removed": file_diffs.stats.removed,
                    "sections": payload["plan"]["sections"].as_array().map(|a| a.len()).unwrap_or(0),
                    "filesChanged": files_changed,
                }),
            );
        }
        let _ = crate::projects::save(&self.state.workspace, &updated);
        self.emit_step("finalize", "done", Some("完成".to_string()), Some(100), None);

        self.run.status = "done".to_string();
        self.run.finished_at = Some(now_ms());
        self.run.summary = Some(format!(
            "已生成 v{}：{} 个文件变更，+{} / -{} 行",
            target_version, files_changed, file_diffs.stats.added, file_diffs.stats.removed
        ));
        let _ = runs::save_run(&project_dir, &self.run);
        self.channel
            .emit("run.done", Some(json!({ "summary": self.run.summary, "status": "done" })));
        json!({ "status": "done", "filesChanged": files_changed })
    }

    fn finish_cancelled(&mut self, step: &str) -> Value {
        self.emit_step(step, "skipped", Some("已取消".to_string()), None, None);
        self.run.status = "cancelled".to_string();
        self.run.finished_at = Some(now_ms());
        let project_dir = self.state.project_dir(&self.run.project_id);
        let _ = runs::save_run(&project_dir, &self.run);
        self.channel.emit("run.done", Some(json!({ "summary": "已取消", "status": "cancelled" })));
        json!({ "status": "cancelled" })
    }
}

/// 重算并落盘 diff.json：流水线结束、应用对话改动后都要用。
/// 返回写入的 payload（含 plan / files / stats）。
pub fn refresh_project_diff(state: &AppState, project: &Value) -> Option<Value> {
    let project_id = project.get("id").and_then(Value::as_str)?;
    let source_dir = state.source_dir(project_id);
    let target_dir = state.target_dir(project);
    let (plan_text, _) = crate::store::read_text(&state.plan_path(project_id), 400_000);
    let (update_doc, _) = crate::store::read_text(&state.update_path(project_id), 400_000);
    let file_diffs = diff::compute_diffs(&source_dir, &target_dir);
    let plan_diff = diff::plan_diff(&plan_text, &update_doc);
    let payload = json!({
        "projectId": project_id,
        "generatedAt": now_ms(),
        "plan": plan_diff,
        "files": file_diffs.files,
        "stats": file_diffs.stats,
    });
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = fs::write(state.diff_path(project_id), text);
    }
    Some(payload)
}

pub struct Inventory {
    pub total: usize,
    pub top_languages: Vec<(String, usize)>,
    pub key_files: Vec<String>,
    pub summary: String,
    pub log_line: String,
}

fn analyze(root: &Path) -> Inventory {
    let files = crate::store::walk_files(root);
    let mut by_ext: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for rel in files.keys() {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if ext.is_empty() || ext.len() > 8 {
            continue;
        }
        *by_ext.entry(ext).or_insert(0) += 1;
    }
    let mut top: Vec<(String, usize)> = by_ext.into_iter().collect();
    top.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    top.truncate(5);

    let mut key_files: Vec<String> = Vec::new();
    for candidate in ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md", "src/index.ts", "src/main.ts"] {
        if files.contains_key(candidate) {
            key_files.push(candidate.to_string());
        }
    }
    if key_files.is_empty() {
        key_files.extend(files.keys().take(5).cloned());
    }

    let languages = top
        .iter()
        .map(|(ext, count)| format!("{}×{}", ext, count))
        .collect::<Vec<_>>()
        .join("，");
    Inventory {
        total: files.len(),
        top_languages: top.clone(),
        key_files: key_files.clone(),
        summary: format!("{} 个文件，主要类型：{}", files.len(), if languages.is_empty() { "未知".to_string() } else { languages.clone() }),
        log_line: format!("结构分析：{} 个文件；关键文件：{}", files.len(), key_files.join(", ")),
    }
}

fn build_update_doc(project: &Value, prompt: &str, plan_text: &str, inventory: &Inventory) -> String {
    let name = project.get("name").and_then(Value::as_str).unwrap_or("项目");
    let base = project.get("baseVersion").and_then(Value::as_str).unwrap_or("1.0.0");
    let target = project.get("targetVersion").and_then(Value::as_str).unwrap_or("1.1.0");
    let excerpt: String = plan_text.chars().take(600).collect();
    format!(
        concat!(
            "# 升级方案：{} v{} → v{}\n\n",
            "## 一、升级目标\n\n{}\n\n",
            "## 二、现状\n\n- 文件总数：{}\n- 主要类型：{}\n- 关键文件：{}\n\n",
            "## 三、改动清单\n\n- 提升版本号到 v{}\n- 生成 CHANGELOG 条目\n",
            "- 生成升级说明 UPGRADE_NOTES.md\n- 在 README 追加升级记录\n\n",
            "## 四、方案摘录\n\n{}\n",
        ),
        name,
        base,
        target,
        if prompt.trim().is_empty() { "按方案页面与现状自动升级" } else { prompt.trim() },
        inventory.total,
        inventory
            .top_languages
            .iter()
            .map(|(ext, count)| format!("{}×{}", ext, count))
            .collect::<Vec<_>>()
            .join("，"),
        inventory.key_files.join("，"),
        target,
        excerpt.replace("\n\n", "\n")
    )
}

fn fetch_plan(project: &Value, plan_path: &Path) -> Result<String, String> {
    let source_url = project.get("sourceUrl").and_then(Value::as_str).unwrap_or("");
    let kind = project.get("sourceKind").and_then(Value::as_str).unwrap_or("page");
    let _ = fs::create_dir_all(plan_path.parent().unwrap_or(Path::new(".")));

    let textual = if kind == "local" || kind == "zip" {
        // 本地来源：如果指向目录，尝试读 README 当方案
        let path = PathBuf::from(source_url);
        if path.is_dir() {
            let readme = path.join("README.md");
            fs::read_to_string(readme).unwrap_or_default()
        } else {
            fs::read_to_string(&path).unwrap_or_default()
        }
    } else if source_url.starts_with("http") {
        fetch_url(source_url).unwrap_or_default()
    } else {
        String::new()
    };

    let plan = if textual.trim().is_empty() {
        format!(
            "# 原始方案（占位）\n\n来源：{}\n\n> 未能抓取到方案内容，已用占位方案继续流水线。\n",
            if source_url.is_empty() { "（未提供）" } else { source_url }
        )
    } else {
        textual
    };
    fs::write(plan_path, &plan).map_err(|error| format!("写入 PLAN.md 失败：{error}"))?;
    Ok(plan)
}

fn fetch_url(url: &str) -> Option<String> {
    let output = Command::new("curl")
        .args(["-sSL", "--max-time", "30", url])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let html = String::from_utf8_lossy(&output.stdout).to_string();
    Some(html_to_text(&html))
}

fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut skip_depth = 0i32;
    let mut tag_buffer = String::new();
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag_buffer.clear();
            }
            '>' => {
                in_tag = false;
                let tag = tag_buffer.to_ascii_lowercase();
                let name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
                if matches!(name.as_str(), "script" | "style") {
                    if tag.starts_with('/') {
                        skip_depth = (skip_depth - 1).max(0);
                    } else {
                        skip_depth += 1;
                    }
                }
                if matches!(name.as_str(), "p" | "div" | "br" | "li" | "h1" | "h2" | "h3" | "h4" | "tr") {
                    out.push('\n');
                }
                tag_buffer.clear();
            }
            _ => {
                if in_tag {
                    tag_buffer.push(ch);
                } else if skip_depth == 0 {
                    out.push(ch);
                }
            }
        }
    }
    let mut lines: Vec<String> = Vec::new();
    for line in out.replace("\r\n", "\n").split('\n') {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            if !lines.last().map(|l: &String| l.is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
        } else {
            lines.push(trimmed);
        }
    }
    lines.join("\n").trim().to_string()
}

fn prepare_source(project: &Value, source_dir: &Path) -> Result<usize, String> {
    let _ = fs::remove_dir_all(source_dir);
    fs::create_dir_all(source_dir).map_err(|error| format!("创建 source 目录失败：{error}"))?;
    let source_url = project.get("sourceUrl").and_then(Value::as_str).unwrap_or("");
    let kind = project.get("sourceKind").and_then(Value::as_str).unwrap_or("page");

    let mut seeded = false;
    if kind == "local" || (kind != "page" && Path::new(source_url).exists()) {
        let path = PathBuf::from(source_url);
        if path.is_dir() {
            copy_tree(&path, source_dir)?;
            seeded = true;
        } else if path.is_file() {
            if let Err(error) = extract_archive(&path, source_dir) {
                // 压缩包解不开就把文件本身放进 source，至少不空
                let _ = fs::copy(&path, source_dir.join(path.file_name().unwrap_or_default()));
                let _ = error;
            }
            seeded = true;
        }
    } else if kind == "git" || source_url.ends_with(".git") {
        if source_url.is_empty() {
            return Err("Git 来源缺少仓库地址".to_string());
        }
        let status = Command::new("git")
            .args(["clone", "--depth", "1", source_url])
            .arg(source_dir)
            .status()
            .map_err(|error| format!("调用 git 失败：{error}"))?;
        if !status.success() {
            return Err(format!("git clone 失败：{}", source_url));
        }
        seeded = true;
    }

    if !seeded {
        scaffold(source_dir)?;
    }
    Ok(crate::store::walk_files(source_dir).len())
}

fn extract_archive(path: &Path, dest: &Path) -> Result<(), String> {
    let name = path.to_string_lossy().to_string();
    let attempts: Vec<Vec<String>> = vec![
        vec!["-xf".to_string(), name.clone(), "-C".to_string(), dest.to_string_lossy().to_string()],
        vec!["-xzf".to_string(), name.clone(), "-C".to_string(), dest.to_string_lossy().to_string()],
    ];
    for args in attempts {
        for program in ["tar", "unzip"] {
            if let Ok(status) = Command::new(program).args(&args).status() {
                if status.success() {
                    return Ok(());
                }
            }
        }
    }
    Err("无法解压压缩包".to_string())
}

fn scaffold(target: &Path) -> Result<(), String> {
    fs::create_dir_all(target.join("src")).map_err(|error| error.to_string())?;
    fs::write(
        target.join("package.json"),
        "{\n  \"name\": \"upgraded-project\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}\n",
    )
    .map_err(|error| error.to_string())?;
    fs::write(target.join("README.md"), "# 项目\n\n由 TSD Agent 生成的基础骨架。\n").map_err(|error| error.to_string())?;
    fs::write(
        target.join("src").join("index.ts"),
        "export function main(): string {\n  return 'ready'\n}\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(from).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(from).map_err(|error| error.to_string())?;
        if rel.components().any(|component| {
            let name = component.as_os_str().to_string_lossy();
            matches!(name.as_ref(), ".git" | "node_modules" | "dist" | "build" | "target")
        }) {
            continue;
        }
        let destination = to.join(rel);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 确定性离线改动：版本号 / CHANGELOG / UPGRADE_NOTES / README 记录
fn apply_changes(
    source_dir: &Path,
    target_dir: &Path,
    project: &Value,
    prompt: &str,
    plan_text: &str,
) -> Result<usize, String> {
    let _ = fs::remove_dir_all(target_dir);
    copy_tree(source_dir, target_dir)?;
    let target_version = project.get("targetVersion").and_then(Value::as_str).unwrap_or("1.1.0");
    let mut changed = 0usize;

    // 1) package.json 版本号
    let package_json = target_dir.join("package.json");
    if let Ok(text) = fs::read_to_string(&package_json) {
        if let Some(updated) = bump_package_version(&text, target_version) {
            if updated != text {
                let _ = fs::write(&package_json, updated);
                changed += 1;
            }
        }
    }

    // 2) CHANGELOG
    let changelog = target_dir.join("CHANGELOG.md");
    let stamp = now_ms();
    let entry = format!(
        "## v{} ({})\n\n- {}\n\n",
        target_version,
        stamp,
        if prompt.trim().is_empty() { "按升级方案完成改造" } else { prompt.trim() }
    );
    let existing = fs::read_to_string(&changelog).unwrap_or_else(|_| "# 变更记录\n\n".to_string());
    let combined = if existing.starts_with("# 变更记录") {
        let (head, rest) = existing.split_at(existing.find('\n').map(|i| i + 1).unwrap_or(existing.len()));
        format!("{}\n{}{}", head.trim_end(), entry, rest)
    } else {
        format!("# 变更记录\n\n{}{}", entry, existing)
    };
    fs::write(&changelog, combined).map_err(|error| error.to_string())?;
    changed += 1;

    // 3) UPGRADE_NOTES
    let notes = target_dir.join("UPGRADE_NOTES.md");
    let excerpt: String = plan_text.chars().take(400).collect();
    fs::write(
        &notes,
        format!(
            "# 升级说明（v{}）\n\n## 需求\n\n{}\n\n## 方案节选\n\n{}\n",
            target_version,
            if prompt.trim().is_empty() { "（未填写需求）" } else { prompt.trim() },
            excerpt
        ),
    )
    .map_err(|error| error.to_string())?;
    changed += 1;

    // 4) README 追加升级记录
    let readme = target_dir.join("README.md");
    let mut readme_text = fs::read_to_string(&readme).unwrap_or_default();
    readme_text.push_str(&format!("\n## 升级记录\n\n- v{}：由 TSD Agent 生成\n", target_version));
    fs::write(&readme, readme_text).map_err(|error| error.to_string())?;
    changed += 1;

    Ok(changed)
}

fn bump_package_version(text: &str, version: &str) -> Option<String> {
    let marker = "\"version\"";
    let start = text.find(marker)?;
    let after = &text[start + marker.len()..];
    let colon = after.find(':')?;
    let rest = &after[colon + 1..];
    let open = rest.find('"')?;
    let close = rest[open + 1..].find('"')?;
    let mut result = String::new();
    result.push_str(&text[..start + marker.len() + colon + 1 + open + 1]);
    result.push_str(version);
    result.push_str(&rest[open + 1 + close..]);
    Some(result)
}
