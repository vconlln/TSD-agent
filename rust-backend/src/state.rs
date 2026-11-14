use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::AtomicBool,
        Arc, Mutex,
    },
    time::Instant,
};

use serde_json::Value;

use crate::events::EventHub;

/// 进程级共享状态：工作区路径、版本、启动时间。
/// 与 Python 参照实现保持同一套目录约定，因此两种后端可以指向同一个 workspace。
pub struct AppState {
    pub workspace: PathBuf,
    pub version: String,
    pub started: Instant,
    pub hub: EventHub,
    /// runId -> 取消标记；流水线在每个阶段边界检查
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            version: env!("CARGO_PKG_VERSION").to_string(),
            started: Instant::now(),
            hub: EventHub::default(),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.workspace.join("projects")
    }

    pub fn project_dir(&self, id: &str) -> PathBuf {
        self.projects_dir().join(id)
    }

    pub fn project_json(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("project.json")
    }

    pub fn plan_path(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("plan").join("PLAN.md")
    }

    pub fn update_path(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("plan").join("UPDATE.md")
    }

    pub fn source_dir(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("source")
    }

    pub fn diff_path(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("diff.json")
    }

    pub fn runs_dir(&self, id: &str) -> PathBuf {
        self.project_dir(id).join("runs")
    }

    pub fn events_path(&self, project_id: &str, run_id: &str) -> PathBuf {
        self.runs_dir(project_id).join(format!("{}.events.jsonl", run_id))
    }

    /// 升级后的代码目录：projects/<id>/v<targetVersion>
    pub fn target_dir(&self, project: &Value) -> PathBuf {
        let id = project.get("id").and_then(Value::as_str).unwrap_or_default();
        let version = project
            .get("targetVersion")
            .and_then(Value::as_str)
            .unwrap_or("1.1.0");
        self.project_dir(id).join(format!("v{}", version))
    }

    pub fn uptime_secs(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }
}

/// 写文件用的路径解析：目标文件可以还不存在（新建文档），但必须落在 root 内。
/// safe_join 会 canonicalize 目标本身，因此只适合读已有文件。
pub fn safe_write_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let trimmed = rel.trim().trim_start_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    let root_norm = root.canonicalize().ok()?;
    let candidate = root_norm.join(trimmed);
    let file_name = candidate.file_name()?.to_owned();
    let parent = candidate.parent()?;
    std::fs::create_dir_all(parent).ok()?;
    let parent_norm = parent.canonicalize().ok()?;
    if !parent_norm.starts_with(&root_norm) {
        return None;
    }
    Some(parent_norm.join(file_name))
}

/// 把用户传进来的相对路径解析到 root 内，越界直接拒绝（与 Python 版 safe_join 等价）。
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let trimmed = rel.trim_start_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let candidate = root.join(trimmed);
    let normalized = candidate.canonicalize().ok()?;
    let root_norm = root.canonicalize().ok()?;
    if normalized.starts_with(&root_norm) {
        Some(normalized)
    } else {
        None
    }
}
