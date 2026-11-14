use std::{path::Path, sync::Arc};

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    diff, state,
    state::AppState,
    store,
};

type ApiResult = Result<Json<Value>, ApiError>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = Json(json!({ "detail": self.1 }));
        (self.0, body).into_response()
    }
}

fn not_found(msg: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, msg.to_string())
}

fn bad_request(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(settings))
        .route("/api/projects", get(list_projects))
        .route("/api/projects/{id}", get(get_project))
        .route("/api/projects/{id}/documents", get(documents))
        .route("/api/projects/{id}/diff", get(project_diff))
        .route("/api/projects/{id}/tree", get(project_tree))
        .route("/api/projects/{id}/file", get(project_file))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    // 引擎状态与 Python 版口径一致：配置完整即 online
    let settings = load_settings(&state);
    let engine = settings
        .get("engine")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let offline = engine.get("offlineMode").and_then(Value::as_bool).unwrap_or(false);
    let has_key = engine
        .get("apiKey")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let online = !offline && has_key;
    Json(json!({
        "ok": true,
        "version": state.version,
        "engine": if online { "online" } else { "offline" },
        "model": if online {
            engine.get("model").and_then(Value::as_str).unwrap_or("").to_string()
        } else {
            "离线启发式".to_string()
        },
        "workspace": state.workspace.to_string_lossy(),
        "uptimeSec": (state.uptime_secs() * 10.0).round() / 10.0,
        "platform": std::env::consts::OS,
    }))
}

fn load_settings(state: &AppState) -> Value {
    store::read_json(&state.workspace.join(".tsd").join("config.json")).unwrap_or_else(|| json!({}))
}

async fn settings(State(state): State<Arc<AppState>>) -> Json<Value> {
    let raw = load_settings(&state);
    let engine = raw.get("engine").cloned().unwrap_or_else(|| json!({}));
    let api_key_set = engine
        .get("apiKey")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    // 永远不回传 apiKey：只给 apiKeySet 布尔
    Json(json!({
        "engine": {
            "provider": engine.get("provider").cloned().unwrap_or_else(|| json!("openai-compatible")),
            "baseUrl": engine.get("baseUrl").cloned().unwrap_or_else(|| json!("")),
            "model": engine.get("model").cloned().unwrap_or_else(|| json!("")),
            "apiKeySet": api_key_set,
            "temperature": engine.get("temperature").cloned().unwrap_or_else(|| json!(0.3)),
            "maxTokens": engine.get("maxTokens").cloned().unwrap_or_else(|| json!(8192)),
            "timeoutSec": engine.get("timeoutSec").cloned().unwrap_or_else(|| json!(300)),
            "offlineMode": engine.get("offlineMode").cloned().unwrap_or_else(|| json!(false)),
        },
        "agent": raw.get("agent").cloned().unwrap_or_else(|| json!({})),
        "w3": raw.get("w3").cloned().unwrap_or_else(|| json!({})),
        "git": raw.get("git").cloned().unwrap_or_else(|| json!({})),
        "workspace": state.workspace.to_string_lossy(),
        "concurrency": raw.get("concurrency").cloned().unwrap_or_else(|| json!(2)),
        "autoApplyChatEdits": raw.get("autoApplyChatEdits").cloned().unwrap_or_else(|| json!(false)),
        "language": raw.get("language").cloned().unwrap_or_else(|| json!("zh-CN")),
    }))
}

fn load_project(state: &AppState, id: &str) -> Option<Value> {
    store::read_json(&state.project_json(id))
}

async fn list_projects(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut projects: Vec<Value> = Vec::new();
    for id in store::list_project_ids(&state.projects_dir()) {
        if let Some(project) = load_project(&state, &id) {
            projects.push(project);
        }
    }
    projects.sort_by_key(|p| {
        std::cmp::Reverse(p.get("updatedAt").and_then(Value::as_u64).unwrap_or(0))
    });
    Json(json!({ "projects": projects }))
}

async fn get_project(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult {
    match load_project(&state, &id) {
        Some(project) => Ok(Json(project)),
        None => Err(not_found("项目不存在")),
    }
}

async fn documents(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult {
    if load_project(&state, &id).is_none() {
        return Err(not_found("项目不存在"));
    }
    let doc = |path: &Path| -> Value {
        let exists = path.exists();
        let (content, _) = if exists {
            store::read_text(path, 2_000_000)
        } else {
            (String::new(), false)
        };
        json!({
            "content": content,
            "path": path.to_string_lossy(),
            "updatedAt": if exists { store::modified_ms(path) } else { 0 },
            "exists": exists,
        })
    };
    Ok(Json(json!({
        "projectId": id,
        "plan": doc(&state.plan_path(&id)),
        "update": doc(&state.update_path(&id)),
    })))
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    refresh: Option<u8>,
}

async fn project_diff(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<DiffQuery>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let diff_path = state.diff_path(&id);
    let refresh = query.refresh.unwrap_or(0) != 0;
    if !refresh {
        if let Some(cached) = store::read_json(&diff_path) {
            return Ok(Json(cached));
        }
    }

    let target_dir = state.target_dir(&project);
    if !target_dir.exists() {
        return Ok(Json(json!({
            "projectId": id,
            "generatedAt": 0u64,
            "plan": { "unified": "", "sections": [], "additions": 0, "deletions": 0 },
            "files": [],
            "stats": { "files": 0, "added": 0, "removed": 0, "filesChanged": 0 },
        })));
    }

    let source_dir = state.source_dir(&id);
    let (plan_text, _) = store::read_text(&state.plan_path(&id), 1_000_000);
    let (update_text, _) = store::read_text(&state.update_path(&id), 1_000_000);

    let file_diffs = diff::compute_diffs(&source_dir, &target_dir);
    let doc_diff = diff::plan_diff(&plan_text, &update_text);
    let payload = json!({
        "projectId": id,
        "generatedAt": store::modified_ms(&target_dir),
        "plan": doc_diff,
        "files": file_diffs.files,
        "stats": file_diffs.stats,
    });

    // 与 Python 版一样落到 diff.json，供 tree 的状态着色复用
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = std::fs::create_dir_all(diff_path.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(&diff_path, text);
    }
    Ok(Json(payload))
}

#[derive(Deserialize)]
struct TreeQuery {
    #[serde(default)]
    side: Option<String>,
}

fn build_tree_node(
    path: &Path,
    rel: &str,
    depth: usize,
    statuses: &std::collections::BTreeMap<String, String>,
) -> Value {
    if path.is_dir() {
        let mut children: Vec<Value> = Vec::new();
        if depth < 12 {
            let mut entries: Vec<_> = std::fs::read_dir(path)
                .map(|iter| iter.flatten().collect::<Vec<_>>())
                .unwrap_or_default();
            entries.sort_by_key(|e| {
                let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
                (is_file, e.file_name().to_string_lossy().to_lowercase())
            });
            for entry in entries {
                let name = entry.file_name().to_string_lossy().to_string();
                if matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "__pycache__" | ".venv" | "venv" | "dist" | "build"
                ) {
                    continue;
                }
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                children.push(build_tree_node(&entry.path(), &child_rel, depth + 1, statuses));
            }
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.to_string());
        return json!({ "name": name, "path": rel, "type": "dir", "children": children });
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let status = statuses.get(rel).cloned().unwrap_or_else(|| "unchanged".to_string());
    json!({
        "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "path": rel,
        "type": "file",
        "size": size,
        "status": status,
    })
}

async fn project_tree(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<TreeQuery>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let side = query.side.unwrap_or_else(|| "target".to_string());
    let root = if side == "source" {
        state.source_dir(&id)
    } else {
        state.target_dir(&project)
    };
    if !root.exists() {
        return Ok(Json(json!({ "tree": Value::Null, "root": root.to_string_lossy(), "exists": false })));
    }
    let statuses = if side == "target" {
        store::read_json(&state.diff_path(&id))
            .map(|value| store::status_map(&value))
            .unwrap_or_default()
    } else {
        Default::default()
    };
    Ok(Json(json!({
        "tree": build_tree_node(&root, "", 0, &statuses),
        "root": root.to_string_lossy(),
        "exists": true,
    })))
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
    #[serde(default)]
    side: Option<String>,
}

async fn project_file(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let side = query.side.unwrap_or_else(|| "target".to_string());
    let root = if side == "source" {
        state.source_dir(&id)
    } else {
        state.target_dir(&project)
    };
    let Some(abs) = state::safe_join(&root, &query.path) else {
        return Err(bad_request("非法路径"));
    };
    if !abs.is_file() {
        return Err(not_found("文件不存在"));
    }
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
    if store::is_binary(&abs) {
        return Ok(Json(json!({
            "path": query.path,
            "content": "",
            "size": size,
            "language": "binary",
            "binary": true,
        })));
    }
    let (content, truncated) = store::read_text(&abs, 2_000_000);
    Ok(Json(json!({
        "path": query.path,
        "content": content,
        "size": size,
        "language": store::language_of(&query.path),
        "truncated": truncated,
        "binary": false,
    })))
}
