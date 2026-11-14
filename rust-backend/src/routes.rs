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
    auth, chat, diff, events, gitops, inline, pipeline, projects, runs, settings, state,
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
        .route("/api/settings", get(get_settings).put(put_settings))
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
        .route("/api/projects/{id}/chat", post(start_chat))
        .route(
            "/api/projects/{id}/apply",
            post(apply_proposal).delete(discard_proposal),
        )
        .route("/api/auth/w3/status", get(w3_status))
        .route("/api/auth/w3/login", post(w3_login))
        .route("/api/auth/w3/logout", post(w3_logout))
        .route("/api/models", get(list_models))
        .route("/api/git/repos", get(git_repos))
        .route("/api/projects/{id}/git/clone", post(git_clone))
        .route("/api/projects/{id}/git/status", get(git_status_endpoint))
        .route("/api/projects/{id}/git/branches", get(git_branches))
        .route("/api/projects/{id}/git/compare", get(git_compare))
        .route("/api/projects/{id}/git/publish", post(git_publish))
        .route("/api/projects/{id}/git/push", post(git_push_endpoint))
        .route("/api/projects/{id}/agent/edit", post(agent_edit))
        .route("/api/projects/{id}/agent/explain", post(agent_explain))
        .route("/api/projects/{id}/files/write", post(write_project_file))
        .route("/api/projects/{id}/search", get(search_project))
        .route("/api/projects/{id}/export", post(export_project))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    // 引擎状态与 Python 版口径一致：offlineMode / provider=offline 时一定是离线
    let settings = settings::load(&state.workspace);
    let engine = settings
        .get("engine")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let online = settings::llm_available(&state.workspace);
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

async fn get_settings(State(state): State<Arc<AppState>>) -> Json<Value> {
    // 敏感字段不回传：engine 只给 apiKeySet，git 只给 tokenSet
    Json(settings::public(&state.workspace))
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<Value>,
) -> Json<Value> {
    Json(settings::update(&state.workspace, &patch))
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
) -> Json<Value> {
    // 与 Python 版一致：删除是幂等的，前端只关心 ok
    projects::delete(&state.workspace, &id);
    Json(json!({ "ok": true }))
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

#[derive(Deserialize)]
struct ChatHistoryItem {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct ChatBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    history: Vec<ChatHistoryItem>,
}

async fn start_chat(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ChatBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    if body.message.trim().is_empty() {
        return Err(bad_request("消息不能为空"));
    }

    let mut run = runs::Run::new(&id, "chat", body.message.trim());
    run.model = Some("chat".to_string());
    let project_dir = state.project_dir(&id);
    let _ = runs::save_run(&project_dir, &run);

    let channel = state
        .hub
        .create(&run.id, Some(state.events_path(&id, &run.id)));
    channel.log("info", "收到对话请求", None);
    channel.emit("run.status", Some(json!({ "status": "running" })));

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.cancels.lock() {
        map.insert(run.id.clone(), cancel.clone());
    }

    // 只保留最近 20 轮，避免上下文无限膨胀
    let history: Vec<Value> = body
        .history
        .iter()
        .filter(|item| !item.content.trim().is_empty())
        .map(|item| json!({ "role": item.role, "content": item.content }))
        .collect();
    let history = history[history.len().saturating_sub(20)..].to_vec();

    let task = chat::ChatTask {
        state: state.clone(),
        channel,
        run: run.clone(),
        cancel,
    };
    let message = body.message.trim().to_string();
    let project_for_task = project.clone();
    tokio::spawn(async move {
        task.run_chat(project_for_task, message, history).await;
    });

    Ok(Json(json!({ "runId": run.id })))
}

#[derive(Deserialize)]
struct ApplyBody {
    #[serde(rename = "proposalId")]
    proposal_id: String,
}

fn proposals_path(state: &AppState, project_id: &str) -> std::path::PathBuf {
    state.project_dir(project_id).join("proposals.json")
}

async fn apply_proposal(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ApplyBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let path = proposals_path(&state, &id);
    let mut proposals = store::read_json(&path).unwrap_or_else(|| json!({}));
    let Some(proposal) = proposals.get(&body.proposal_id).cloned() else {
        return Err(not_found("修改建议不存在"));
    };

    let target_dir = state.target_dir(&project);
    let _ = std::fs::create_dir_all(&target_dir);
    let mut written: Vec<String> = Vec::new();
    if let Some(edits) = proposal.get("edits").and_then(Value::as_array) {
        for edit in edits {
            let rel = edit
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_start_matches("./")
                .to_string();
            let Some(content) = edit.get("after").and_then(Value::as_str) else {
                continue;
            };
            if rel.is_empty() {
                continue;
            }
            let Some(target) = state::safe_write_path(&target_dir, &rel) else {
                continue;
            };
            if std::fs::write(&target, content).is_ok() {
                written.push(rel);
            }
        }
    }

    if let Some(object) = proposals.as_object_mut() {
        if let Some(entry) = object.get_mut(&body.proposal_id).and_then(Value::as_object_mut) {
            entry.insert("applied".to_string(), json!(true));
            entry.insert("appliedAt".to_string(), json!(events::now_ms()));
        }
    }
    if let Ok(text) = serde_json::to_string_pretty(&proposals) {
        let _ = std::fs::write(&path, text);
    }

    // 应用后立刻刷新差异，前端不用等下一次回归
    if let Some(payload) = pipeline::refresh_project_diff(&state, &project) {
        let mut updated = project.clone();
        if let Some(object) = updated.as_object_mut() {
            object.insert("status".to_string(), json!("ready"));
            object.insert("updatedAt".to_string(), json!(events::now_ms()));
            object.insert(
                "stats".to_string(),
                json!({
                    "files": payload["stats"]["files"],
                    "added": payload["stats"]["added"],
                    "removed": payload["stats"]["removed"],
                    "sections": payload["plan"]["sections"].as_array().map(|a| a.len()).unwrap_or(0),
                    "filesChanged": payload["stats"]["filesChanged"],
                }),
            );
        }
        let _ = projects::save(&state.workspace, &updated);
    }

    Ok(Json(json!({ "ok": true, "files": written })))
}

async fn discard_proposal(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ApplyBody>,
) -> ApiResult {
    if load_project(&state, &id).is_none() {
        return Err(not_found("项目不存在"));
    }
    let path = proposals_path(&state, &id);
    let mut proposals = store::read_json(&path).unwrap_or_else(|| json!({}));
    if let Some(object) = proposals.as_object_mut() {
        if let Some(entry) = object.get_mut(&body.proposal_id).and_then(Value::as_object_mut) {
            entry.insert("discarded".to_string(), json!(true));
        }
    }
    if let Ok(text) = serde_json::to_string_pretty(&proposals) {
        let _ = std::fs::write(&path, text);
    }
    Ok(Json(json!({ "ok": true })))
}


// ----------------------------------------------------------------------
// W3 凭证与模型
// ----------------------------------------------------------------------

#[derive(Deserialize)]
struct LoginBody {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

fn auth_error(error: auth::AuthError) -> ApiError {
    ApiError(
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        error.message,
    )
}

async fn w3_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(auth::status(&state).await)
}

async fn w3_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> ApiResult {
    auth::login(&state, &body.username, &body.password)
        .await
        .map(Json)
        .map_err(auth_error)
}

async fn w3_logout(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(auth::logout(&state))
}

async fn list_models(State(state): State<Arc<AppState>>) -> ApiResult {
    auth::models(&state).await.map(Json).map_err(auth_error)
}

// ----------------------------------------------------------------------
// Git
// ----------------------------------------------------------------------

fn git_error(error: gitops::GitError) -> ApiError {
    ApiError(
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        error.message,
    )
}

#[derive(Deserialize)]
struct ReposQuery {
    #[serde(default)]
    prefix: Option<String>,
}

async fn git_repos(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ReposQuery>,
) -> Json<Value> {
    let prefix = query.prefix.unwrap_or_default();
    Json(gitops::search_repos(&state, &prefix).await)
}

#[derive(Deserialize)]
struct GitCloneBody {
    #[serde(default)]
    url: String,
    #[serde(default)]
    branch: Option<String>,
}

async fn git_clone(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<GitCloneBody>,
) -> ApiResult {
    let Some(mut project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let url = body.url.clone();
    let branch = body.branch.clone();
    let result = tokio::task::spawn_blocking(move || {
        gitops::clone_project(&state_for_task, &mut project, &url, branch.as_deref())
    })
    .await
    .map_err(|error| bad_request(&format!("克隆任务失败：{error}")))?;
    let cloned = result.map_err(git_error)?;
    // 克隆完立刻刷新差异（升级结果可能已存在）
    if let Some(project) = load_project(&state, &id) {
        pipeline::refresh_project_diff(&state, &project);
    }
    Ok(Json(cloned))
}

async fn git_status_endpoint(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let value = tokio::task::spawn_blocking(move || gitops::status(&state_for_task, &project))
        .await
        .map_err(|error| bad_request(&format!("读取状态失败：{error}")))?;
    Ok(Json(value))
}

async fn git_branches(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let result = tokio::task::spawn_blocking(move || gitops::branches(&state_for_task, &project))
        .await
        .map_err(|error| bad_request(&format!("读取分支失败：{error}")))?;
    result.map(Json).map_err(git_error)
}

#[derive(Deserialize)]
struct CompareQuery {
    #[serde(default)]
    base: Option<String>,
}

async fn git_compare(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<CompareQuery>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let base = query.base;
    let result = tokio::task::spawn_blocking(move || {
        gitops::compare(&state_for_task, &project, base.as_deref())
    })
    .await
    .map_err(|error| bad_request(&format!("对比失败：{error}")))?;
    result.map(Json).map_err(git_error)
}

#[derive(Deserialize)]
struct GitPublishBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    remote: Option<String>,
    #[serde(default)]
    push: Option<bool>,
    #[serde(default, rename = "createBranch")]
    create_branch: Option<bool>,
    #[serde(default)]
    force: Option<bool>,
}

async fn git_publish(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<GitPublishBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let remote = body.remote.unwrap_or_else(|| "origin".to_string());
    let push = body.push.unwrap_or(true);
    let create_branch = body.create_branch.unwrap_or(true);
    let force = body.force.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || {
        gitops::publish(
            &state_for_task,
            &project,
            &body.message,
            &body.branch,
            push,
            &remote,
            create_branch,
            force,
        )
    })
    .await
    .map_err(|error| bad_request(&format!("提交失败：{error}")))?;
    result.map(Json).map_err(git_error)
}

#[derive(Deserialize)]
struct GitPushBody {
    #[serde(default)]
    branch: String,
    #[serde(default)]
    remote: Option<String>,
}

async fn git_push_endpoint(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<GitPushBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let state_for_task = state.clone();
    let remote = body.remote.unwrap_or_else(|| "origin".to_string());
    let result = tokio::task::spawn_blocking(move || {
        gitops::push(&state_for_task, &project, &body.branch, &remote)
    })
    .await
    .map_err(|error| bad_request(&format!("推送失败：{error}")))?;
    result.map(Json).map_err(git_error)
}

// ----------------------------------------------------------------------
// 编辑器内 AI / 文件写回 / 搜索 / 导出
// ----------------------------------------------------------------------

#[derive(Deserialize)]
struct AgentEditBody {
    #[serde(default)]
    path: String,
    #[serde(default)]
    instruction: String,
    #[serde(default, rename = "startLine")]
    start_line: Option<u64>,
    #[serde(default, rename = "endLine")]
    end_line: Option<u64>,
    #[serde(default)]
    content: Option<String>,
}

fn inline_error(error: inline::InlineError) -> ApiError {
    ApiError(
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        error.message,
    )
}

async fn agent_edit(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<AgentEditBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    inline::edit(
        &state,
        &project,
        &body.path,
        &body.instruction,
        body.start_line.unwrap_or(0),
        body.end_line.unwrap_or(0),
        body.content.as_deref(),
    )
    .await
    .map(Json)
    .map_err(inline_error)
}

#[derive(Deserialize)]
struct AgentExplainBody {
    #[serde(default)]
    path: String,
    #[serde(default, rename = "startLine")]
    start_line: Option<u64>,
    #[serde(default, rename = "endLine")]
    end_line: Option<u64>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    question: Option<String>,
}

async fn agent_explain(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<AgentExplainBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    inline::explain(
        &state,
        &project,
        &body.path,
        body.start_line.unwrap_or(0),
        body.end_line.unwrap_or(0),
        body.content.as_deref(),
        body.question.as_deref(),
    )
    .await
    .map(Json)
    .map_err(inline_error)
}

#[derive(Deserialize)]
struct FileWriteBody {
    #[serde(default)]
    path: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    side: Option<String>,
}

async fn write_project_file(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<FileWriteBody>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let side = body.side.unwrap_or_else(|| "target".to_string());
    let root = if side == "source" {
        state.source_dir(&id)
    } else {
        state.target_dir(&project)
    };
    if root.exists() {
        if let Some(parent) = root.parent() {
            let _ = parent;
        }
    } else {
        let _ = std::fs::create_dir_all(&root);
    }
    let Some(target) = state::safe_write_path(&root, &body.path) else {
        return Err(bad_request("非法路径"));
    };
    std::fs::write(&target, body.content.as_bytes())
        .map_err(|error| bad_request(&format!("写入失败：{error}")))?;
    let size = body.content.len();
    if side != "source" {
        pipeline::refresh_project_diff(&state, &project);
    }
    Ok(Json(json!({ "ok": true, "size": size })))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    side: Option<String>,
}

async fn search_project(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SearchQuery>,
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
        return Ok(Json(json!({ "results": [] })));
    }
    let needle = query.q.trim().to_string();
    if needle.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }
    let needle_lower = needle.to_lowercase();
    let mut results: Vec<Value> = Vec::new();
    for (rel, size) in store::walk_files(&root) {
        if rel.to_lowercase().contains(&needle_lower) {
            results.push(json!({ "path": rel, "size": size, "reason": "path" }));
            if results.len() >= 80 {
                break;
            }
            continue;
        }
        let path = root.join(&rel);
        if store::is_binary(&path) || size > 400_000 {
            continue;
        }
        let (text, _) = store::read_text(&path, 400_000);
        if text.contains(&needle) {
            results.push(json!({ "path": rel, "size": size, "reason": "content" }));
            if results.len() >= 80 {
                break;
            }
        }
    }
    Ok(Json(json!({ "results": results })))
}

async fn export_project(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult {
    let Some(project) = load_project(&state, &id) else {
        return Err(not_found("项目不存在"));
    };
    let exports_dir = state.workspace.join("exports");
    let _ = std::fs::create_dir_all(&exports_dir);
    let slug = project.get("slug").and_then(Value::as_str).unwrap_or(&id).to_string();
    let version = project
        .get("targetVersion")
        .and_then(Value::as_str)
        .unwrap_or("next")
        .to_string();
    let stamp = chrono_like_stamp();
    let archive_path = exports_dir.join(format!("{slug}-v{version}-{stamp}.zip"));

    let plan_path = state.plan_path(&id);
    let update_path = state.update_path(&id);
    let diff_path = state.diff_path(&id);
    let target_dir = state.target_dir(&project);

    let file = std::fs::File::create(&archive_path)
        .map_err(|error| bad_request(&format!("创建压缩包失败：{error}")))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: String, path: &std::path::Path| -> std::io::Result<()> {
        let bytes = std::fs::read(path)?;
        archive.start_file(name, options)?;
        std::io::Write::write_all(&mut archive, &bytes)?;
        Ok(())
    };
    for (name, path) in [
        ("plan/PLAN.md", &plan_path),
        ("plan/UPDATE.md", &update_path),
        ("diff.json", &diff_path),
    ] {
        if path.exists() {
            let _ = add(name.to_string(), path);
        }
    }
    if target_dir.exists() {
        for rel in store::walk_files(&target_dir).keys() {
            let path = target_dir.join(rel);
            let _ = add(format!("code/{rel}"), &path);
        }
    }
    if let Err(error) = archive.finish() {
        return Err(bad_request(&format!("写入压缩包失败：{error}")));
    }
    Ok(Json(json!({ "ok": true, "path": archive_path.to_string_lossy() })))
}

/// yyyymmdd-HHMMSS（导出文件名用，不引入 chrono）
fn chrono_like_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|dur| dur.as_secs())
        .unwrap_or(0) as i64;
    let days = now.div_euclid(86_400);
    let seconds = now.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year,
        month,
        day,
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// Unix 天数 → 公历（Howard Hinnant 算法）
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

