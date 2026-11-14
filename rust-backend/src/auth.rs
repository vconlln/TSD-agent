//! W3 访问凭证与模型清单。
//!
//! 与 Python 参照实现一致：
//!   - 配置了 w3.serverUrl 时走真实网关（登录 + 模型列表）；
//!   - 未配置时进入演示模式，签发本地演示凭证并返回内置模型清单；
//!   - 密码永远不落盘，只缓存 token / 用户信息 / 过期时间。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{settings, state::AppState};

const DEMO_PASSWORD_MIN: usize = 4;
const DEFAULT_TTL_SECONDS: u64 = 8 * 3600;

pub struct AuthError {
    pub status: u16,
    pub message: String,
}

impl AuthError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

pub fn builtin_models() -> Vec<Value> {
    vec![
        json!({
            "id": "deepseek-chat",
            "name": "DeepSeek Chat",
            "provider": "deepseek",
            "contextWindow": 65536,
            "tags": ["通用", "快速"],
            "recommended": true,
        }),
        json!({
            "id": "deepseek-reasoner",
            "name": "DeepSeek Reasoner",
            "provider": "deepseek",
            "contextWindow": 65536,
            "tags": ["推理", "长文"],
        }),
        json!({
            "id": "qwen2.5-coder-32b",
            "name": "Qwen2.5 Coder 32B",
            "provider": "internal",
            "contextWindow": 131072,
            "tags": ["代码", "内部"],
        }),
        json!({
            "id": "internal-large",
            "name": "内部大模型 Large",
            "provider": "internal",
            "contextWindow": 131072,
            "tags": ["内部", "长上下文"],
        }),
    ]
}

fn w3_config(workspace: &std::path::Path) -> Value {
    settings::load(workspace)
        .get("w3")
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn configured(workspace: &std::path::Path) -> bool {
    !text_of(&w3_config(workspace), "serverUrl").trim().is_empty()
}

struct Session {
    token: String,
    user: Value,
    expires_at: u64,
    mode: String,
}

/// 从配置里恢复会话；已过期则清掉
fn session(workspace: &std::path::Path) -> Option<Session> {
    let w3 = w3_config(workspace);
    let token = text_of(&w3, "token");
    let expires_at = w3.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);
    if token.is_empty() {
        return None;
    }
    if expires_at <= now_ms() {
        // 过期即清空，行为与 Python 的 token() 一致
        persist(workspace, None);
        return None;
    }
    let mode = {
        let value = text_of(&w3, "mode");
        if value.is_empty() { "w3".to_string() } else { value }
    };
    Some(Session {
        token,
        user: w3.get("user").cloned().unwrap_or_else(|| json!({})),
        expires_at,
        mode,
    })
}

fn persist(workspace: &std::path::Path, session: Option<&Session>) {
    let patch = match session {
        Some(item) => json!({
            "w3": {
                "token": item.token,
                "user": item.user,
                "expiresAt": item.expires_at,
                "mode": item.mode,
            }
        }),
        None => json!({
            "w3": { "token": "", "user": {}, "expiresAt": 0, "mode": "" }
        }),
    };
    settings::update(workspace, &patch);
}

fn preview(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 10 {
        return format!("{}…", chars.iter().take(4).collect::<String>());
    }
    format!(
        "{}…{}",
        chars.iter().take(6).collect::<String>(),
        chars[chars.len() - 4..].iter().collect::<String>()
    )
}

/// 登录状态（会按需补拉模型清单）
pub async fn status(state: &AppState) -> Value {
    let workspace = state.workspace.as_path();
    let configured = configured(workspace);
    let remember = text_of(&w3_config(workspace), "rememberUsername");
    let Some(current) = session(workspace) else {
        return json!({
            "authenticated": false,
            "configured": configured,
            "mode": if configured { "w3" } else { "demo" },
            "rememberUsername": remember,
            "models": [],
        });
    };

    ensure_models(state, &current.mode).await;
    let models = state
        .w3_models
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();
    json!({
        "authenticated": true,
        "configured": configured,
        "mode": current.mode,
        "user": current.user,
        "expiresAt": current.expires_at,
        "tokenPreview": preview(&current.token),
        "rememberUsername": remember,
        "models": models,
    })
}

pub async fn login(
    state: &AppState,
    username: &str,
    password: &str,
) -> Result<Value, AuthError> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AuthError::new(400, "请输入用户名"));
    }
    if password.is_empty() {
        return Err(AuthError::new(400, "请输入密码"));
    }
    let workspace = state.workspace.clone();
    let w3 = w3_config(&workspace);
    let server = text_of(&w3, "serverUrl").trim().trim_end_matches('/').to_string();

    let session = if server.is_empty() {
        demo_login(&username, password)?
    } else {
        remote_login(&server, &w3, &username, password).await?
    };

    persist(&workspace, Some(&session));
    settings::update(&workspace, &json!({ "w3": { "rememberUsername": username } }));
    if let Ok(mut list) = state.w3_models.lock() {
        list.clear();
    }
    refresh_models(state, &session).await;
    Ok(status(state).await)
}

async fn refresh_models(state: &AppState, session: &Session) {
    let models = load_models(&state.workspace, Some(session)).await;
    if let Ok(mut list) = state.w3_models.lock() {
        *list = models;
    }
}

fn demo_login(username: &str, password: &str) -> Result<Session, AuthError> {
    if password.chars().count() < DEMO_PASSWORD_MIN {
        return Err(AuthError::new(
            400,
            format!("演示模式下密码至少 {DEMO_PASSWORD_MIN} 位"),
        ));
    }
    let token = format!("demo-{}", crate::runs::random_id());
    Ok(Session {
        token,
        user: json!({
            "id": format!("demo-{username}"),
            "name": username,
            "email": "",
            "department": "演示租户",
        }),
        expires_at: now_ms() + DEFAULT_TTL_SECONDS * 1000,
        mode: "demo".to_string(),
    })
}

async fn remote_login(
    server: &str,
    w3: &Value,
    username: &str,
    password: &str,
) -> Result<Session, AuthError> {
    let login_path = {
        let value = text_of(w3, "loginPath");
        if value.is_empty() { "/api/v1/auth/login".to_string() } else { value }
    };
    let url = format!("{server}{login_path}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AuthError::new(502, format!("无法连接 W3 服务：{error}")))?;
    let response = client
        .post(&url)
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|error| AuthError::new(502, format!("无法连接 W3 服务：{error}")))?;

    let status = response.status();
    if status.as_u16() == 401 {
        return Err(AuthError::new(401, "用户名或密码错误"));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .map(|value| {
                value
                    .get("message")
                    .or_else(|| value.get("detail"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_else(|| body.chars().take(200).collect::<String>());
        return Err(AuthError::new(
            502,
            format!("W3 登录失败（{}）{}", status.as_u16(), detail).trim().to_string(),
        ));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|_: reqwest::Error| AuthError::new(502, "W3 返回内容不是 JSON"))?;
    let token = {
        let mut token = text_of(&body, "token");
        if token.is_empty() {
            token = text_of(&body, "accessToken");
        }
        if token.is_empty() {
            token = text_of(&body, "access_token");
        }
        token
    };
    if token.is_empty() {
        return Err(AuthError::new(502, "W3 未返回访问凭证"));
    }
    let mut user = body
        .get("user")
        .or_else(|| body.get("profile"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !user.is_object() {
        user = json!({ "name": user.as_str().unwrap_or(username) });
    }
    if user.get("name").and_then(Value::as_str).unwrap_or("").is_empty() {
        user["name"] = json!(username);
    }
    let ttl = body
        .get("expiresIn")
        .or_else(|| body.get("expiresInSec"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TTL_SECONDS)
        .max(60);
    Ok(Session {
        token,
        user,
        expires_at: now_ms() + ttl * 1000,
        mode: "w3".to_string(),
    })
}

async fn ensure_models(state: &AppState, mode: &str) {
    let empty = state
        .w3_models
        .lock()
        .map(|list| list.is_empty())
        .unwrap_or(true);
    if !empty {
        return;
    }
    let session = session(&state.workspace).map(|current| Session { mode: mode.to_string(), ..current });
    let models = load_models(&state.workspace, session.as_ref()).await;
    if let Ok(mut list) = state.w3_models.lock() {
        *list = models;
    }
}

async fn load_models(workspace: &std::path::Path, session: Option<&Session>) -> Vec<Value> {
    let Some(session) = session else {
        return builtin_models();
    };
    let w3 = w3_config(workspace);
    let server = text_of(&w3, "serverUrl").trim().trim_end_matches('/').to_string();
    if server.is_empty() || session.mode != "w3" {
        return builtin_models();
    }
    let path = {
        let value = text_of(&w3, "modelsPath");
        if value.is_empty() { "/api/v1/models".to_string() } else { value }
    };
    let url = format!("{server}{path}");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => return builtin_models(),
    };
    let response = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", session.token))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return builtin_models(),
    };
    if !response.status().is_success() {
        return builtin_models();
    }
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(_) => return builtin_models(),
    };
    let raw: Vec<Value> = if body.is_object() {
        body.get("models")
            .or_else(|| body.get("data"))
            .or_else(|| body.get("items"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        body.as_array().cloned().unwrap_or_default()
    };

    let mut models = Vec::new();
    for item in raw {
        if !item.is_object() {
            continue;
        }
        let mut id = text_of(&item, "id");
        if id.is_empty() {
            id = text_of(&item, "model");
        }
        if id.is_empty() {
            id = text_of(&item, "name");
        }
        if id.is_empty() {
            continue;
        }
        let name = {
            let value = text_of(&item, "name");
            if value.is_empty() { text_of(&item, "displayName") } else { value }
        };
        let provider = {
            let value = text_of(&item, "provider");
            if value.is_empty() { "w3".to_string() } else { value }
        };
        let context = item
            .get("contextWindow")
            .or_else(|| item.get("context_length"))
            .cloned()
            .unwrap_or(Value::Null);
        let tags = if item.get("tags").map(Value::is_array).unwrap_or(false) {
            item.get("tags").cloned().unwrap_or_else(|| json!([]))
        } else {
            json!([])
        };
        models.push(json!({
            "id": id,
            "name": if name.is_empty() { id.clone() } else { name },
            "provider": provider,
            "contextWindow": context,
            "tags": tags,
        }));
    }
    if models.is_empty() {
        builtin_models()
    } else {
        models
    }
}

pub async fn models(state: &AppState) -> Result<Value, AuthError> {
    let Some(current) = session(&state.workspace) else {
        return Err(AuthError::new(401, "尚未登录 W3"));
    };
    ensure_models(state, &current.mode).await;
    let list = state
        .w3_models
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();
    let source = if current.mode == "w3" { "w3" } else { "builtin" };
    Ok(json!({ "models": list, "source": source }))
}

pub fn logout(state: &AppState) -> Value {
    persist(&state.workspace, None);
    if let Ok(mut list) = state.w3_models.lock() {
        list.clear();
    }
    json!({ "ok": true })
}
