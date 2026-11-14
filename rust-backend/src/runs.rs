//! 运行记录：创建 / 读取 / 列表 / 步骤写回。
//!
//! 关键约定（前端刷新后只看 run.json，不看事件）：
//!   - 创建 run 时就带齐 7 个 pending 步骤；
//!   - 每次 step.status 事件都要把状态写回 run.json。

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{events::now_ms, store};

pub const UPGRADE_STEPS: &[(&str, &str)] = &[
    ("fetch", "解析方案页面"),
    ("download", "下载基础代码"),
    ("analyze", "分析项目结构"),
    ("update", "生成升级方案"),
    ("code", "升级代码"),
    ("diff", "计算差异"),
    ("finalize", "整理结果"),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunStep {
    pub key: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Value>,
}

impl RunStep {
    pub fn pending(key: &str, title: &str) -> Self {
        Self {
            key: key.to_string(),
            title: title.to_string(),
            status: "pending".to_string(),
            detail: None,
            started_at: None,
            finished_at: None,
            progress: None,
            metrics: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub kind: String,
    pub status: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub steps: Vec<RunStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub usage: Value,
}

impl Run {
    pub fn new(project_id: &str, kind: &str, prompt: &str) -> Self {
        let id = random_id();
        Self {
            id,
            project_id: project_id.to_string(),
            kind: kind.to_string(),
            status: "running".to_string(),
            prompt: prompt.to_string(),
            started_at: now_ms(),
            finished_at: None,
            steps: UPGRADE_STEPS
                .iter()
                .map(|(key, title)| RunStep::pending(key, title))
                .collect(),
            error: None,
            summary: None,
            model: None,
            usage: json!({}),
        }
    }

    pub fn set_step(&mut self, key: &str, status: &str, detail: Option<String>, metrics: Option<Value>, progress: Option<u32>) {
        if let Some(step) = self.steps.iter_mut().find(|step| step.key == key) {
            step.status = status.to_string();
            if let Some(detail) = detail {
                step.detail = Some(detail);
            }
            if let Some(metrics) = metrics {
                step.metrics = Some(metrics);
            }
            if let Some(progress) = progress {
                step.progress = Some(progress);
            }
            match status {
                "running" => {
                    if step.started_at.is_none() {
                        step.started_at = Some(now_ms());
                    }
                }
                "done" | "failed" | "skipped" => {
                    step.finished_at = Some(now_ms());
                    if step.progress.is_none() {
                        step.progress = Some(if status == "done" { 100 } else { 0 });
                    }
                }
                _ => {}
            }
        }
    }
}

pub fn runs_dir(project_dir: &std::path::Path) -> PathBuf {
    project_dir.join("runs")
}

pub fn run_path(project_dir: &std::path::Path, run_id: &str) -> PathBuf {
    runs_dir(project_dir).join(format!("{}.json", run_id))
}

pub fn save_run(project_dir: &std::path::Path, run: &Run) -> std::io::Result<()> {
    let path = run_path(project_dir, &run.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(run).unwrap_or_else(|_| "{}".to_string());
    fs::write(path, text)
}

pub fn load_run(project_dir: &std::path::Path, run_id: &str) -> Option<Run> {
    let path = run_path(project_dir, run_id);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn list_runs(project_dir: &std::path::Path) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let Ok(entries) = fs::read_dir(runs_dir(project_dir)) else {
        return runs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Some(run) = store::read_json(&path).and_then(|value| serde_json::from_value::<Run>(value).ok()) {
            runs.push(run);
        }
    }
    runs.sort_by_key(|run| std::cmp::Reverse(run.started_at));
    runs
}

/// 12 位十六进制 id，和 Python 参照实现同长度
pub fn random_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{:012x}", hasher.finish() & 0xFFFF_FFFF_FFFF)
}
