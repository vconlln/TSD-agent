use std::{path::Path, sync::Arc};

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    diff, events, pipeline, projects, runs, state,
    state::AppState,
    store,
};
use std::sync::atomic::{AtomicBool, Ordering};

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
        .route("/api/projects", post(create_project))
        .route("/api/projects/{id}", patch(patch_project))
        .route("/api/projects/{id}", delete(delete_project))
        .route("/api/projects/{id}/run", post(start_run))
        .route("/api/runs", get(list_runs))
        .route("/api/runs/{id}", get(get_run))
        .route("/api/runs/{id}/cancel", post(cancel_run))
        .route("/api/runs/{id}/events", get(run_events))
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

// ======================================================================
// L2：项目写接口 + 运行 + SSE 事件流
// ======================================================================

#[derive(Deserialize)]
struct CreateProjectBody {
    name: String,
    #[serde(default)]
    #[serde(rename = "sourceUrl")]
    source_url: Option<String>,
    #[serde(default)]
    #[serde(rename = "sourceKind")]
    source_kind: Option<String>,
    #[serde(default)]
    #[serde(rename = "targetVersion")]
    target_version: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

async fn create_project(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProjectBody>,
) -> ApiResult {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("项目名不能为空"));
    }
    let project = projects::create(
        &state.workspace,
        name,
        body.source_url.as_deref().unwrap_or(""),
        body.source_kind.as_deref().unwrap_or("page"),
        body.target_version.as_deref().unwrap_or(""),
        body.description.as_deref().unwrap_or(""),
    );
    Ok(Json(project))
}

async fn patch_project(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<Value>,
) -> ApiResult {
    match projects::patch(&state.workspace, &id, &patch) {
        Some(project) => Ok(Json(project)),
        None => Err(not_found("项目不存在")),
    }
}

async fn delete_project(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if projects::delete(&state.workspace, &id) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

#[derive(Deserialize)]
struct StartRunBody {
    #[serde(default)]
    #[serde(rename = "upgradeRequest")]
    upgrade_request: Option<String>,
    #[serde(default)]
    #[serde(rename = "targetVersion")]
    target_version: Option<String>,
    #[serde(default)]
    #[serde(rename = "referenceUrl")]
    reference_url: Option<String>,
}

async fn start_run(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<StartRunBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };

    // 同一个项目同时只允许一个运行
    let existing = runs::list_runs(&state.project_dir(&id));
    if existing.iter().any(|run| run.status == "running") {
        return Err(ApiError(StatusCode::CONFLICT, "该项目已有正在执行的任务".to_string()));
    }

    let target_version = body
        .target_version
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| project.get("targetVersion").and_then(Value::as_str).map(|s| s.to_string()))
        .unwrap_or_else(|| "1.1.0".to_string());

    let mut project = project;
    if let Some(object) = project.as_object_mut() {
        object.insert("targetVersion".to_string(), json!(target_version));
        object.insert("status".to_string(), json!("running"));
        object.insert("updatedAt".to_string(), json!(events::now_ms()));
    }
    let _ = projects::save(&state.workspace, &project);

    let prompt = body
        .upgrade_request
        .clone()
        .or_else(|| body.reference_url.clone())
        .unwrap_or_default();
    let mut run = runs::Run::new(&id, "upgrade", &prompt);
    run.model = Some("offline".to_string());
    let project_dir = state.project_dir(&id);
    let _ = runs::save_run(&project_dir, &run);

    let channel = state
        .hub
        .create(&run.id, Some(state.events_path(&id, &run.id)));
    channel.emit(
        "run.status",
        Some(json!({ "status": "running" })),
    );


    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.cancels.lock() {
        map.insert(run.id.clone(), cancel.clone());
    }

    let pipeline = pipeline::Pipeline {
        state: state.clone(),
        channel: channel.clone(),
        run: run.clone(),
        cancel,
    };
    let project_for_task = project.clone();
    let prompt_for_task = prompt.clone();
    let target_for_task = run.project_id.is_empty().then(String::new).unwrap_or_default();
    let _ = target_for_task;
    let target_version_for_task = project
        .get("targetVersion")
        .and_then(Value::as_str)
        .unwrap_or("1.1.0")
        .to_string();
    tokio::spawn(async move {
        pipeline
            .run_upgrade(project_for_task, prompt_for_task, target_version_for_task)
            .await;
    });

    Ok(Json(json!({ "runId": run.id, "run": run })))
}

#[derive(Deserialize)]
struct RunsQuery {
    #[serde(default)]
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}

async fn list_runs(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RunsQuery>,
) -> ApiResult {
    let Some(project_id) = query.project_id else {
        return Err(bad_request("缺少 projectId"));
    };
    if load_project(&state, &project_id).is_none() {
        return Err(not_found("项目不存在"));
    }
    let runs = runs::list_runs(&state.project_dir(&project_id));
    Ok(Json(json!({ "runs": runs })))
}

async fn get_run(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult {
    if let Some(channel) = state.hub.get(&run_id) {
        let _ = channel;
    }
    for project_id in store::list_project_ids(&state.projects_dir()) {
        if let Some(run) = runs::load_run(&state.project_dir(&project_id), &run_id) {
            return Ok(Json(serde_json::to_value(run).unwrap_or_else(|_| json!({}))));
        }
    }
    Err(not_found("运行记录不存在"))
}

async fn cancel_run(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult {
    let flag = state
        .cancels
        .lock()
        .ok()
        .and_then(|map| map.get(&run_id).cloned());
    match flag {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            if let Some(channel) = state.hub.get(&run_id) {
                channel.log("warn", "收到取消请求，正在收尾", None);
            }
            Ok(Json(json!({ "ok": true })))
        }
        None => Err(not_found("运行记录不存在或已结束")),
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    since: Option<u64>,
}



async fn run_events(
    State(state): State<Arc<AppState>>,
    AxumPath(run_id): AxumPath<String>,
    Query(query): Query<EventsQuery>,
) -> axum::response::Response {
    let since = query.since.unwrap_or(0);

    let Some(channel) = state.hub.get(&run_id) else {
        // 进程重启后内存通道没了：从 events.jsonl 回放
        return replay_from_disk(&state, &run_id, since);
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<SseEvent, std::convert::Infallible>>();
    tokio::spawn(async move {
        let mut last = since;
        let mut saw_terminal = false;
        for event in channel.history_since(since) {
            last = last.max(event.seq);
            saw_terminal |= event.is_terminal();
            if tx.send(Ok(to_sse(&event))).is_err() {
                return;
            }
        }
        if saw_terminal || channel.is_closed() {
            let _ = tx.send(Ok(SseEvent::default().data("[DONE]")));
            return;
        }

        let mut receiver = channel.subscribe();
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if event.seq <= last {
                        continue;
                    }
                    last = event.seq;
                    if tx.send(Ok(to_sse(&event))).is_err() {
                        return;
                    }
                    if event.is_terminal() {
                        let _ = tx.send(Ok(SseEvent::default().data("[DONE]")));
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    let _ = tx.send(Ok(SseEvent::default().data("[DONE]")));
                    return;
                }
            }
        }
    });

    Sse::new(tokio_stream::wrappers::UnboundedReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

fn to_sse(event: &events::Event) -> SseEvent {
    let payload = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    SseEvent::default().data(payload)
}

fn replay_from_disk(state: &AppState, run_id: &str, since: u64) -> axum::response::Response {
    let mut events: Vec<events::Event> = Vec::new();
    let mut found = false;
    for project_id in store::list_project_ids(&state.projects_dir()) {
        let path = state.events_path(&project_id, run_id);
        if !path.exists() {
            continue;
        }
        found = true;
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if let Ok(event) = serde_json::from_str::<events::Event>(line) {
                    if event.seq > since {
                        events.push(event);
                    }
                }
            }
        }
        break;
    }
    if !found {
        return ApiError(StatusCode::NOT_FOUND, "事件流不存在".to_string()).into_response();
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<SseEvent, std::convert::Infallible>>();
    tokio::spawn(async move {
        for event in events {
            if tx.send(Ok(to_sse(&event))).is_err() {
                return;
            }
        }
        let _ = tx.send(Ok(SseEvent::default().data("[DONE]")));
    });
    Sse::new(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)).into_response()
}
