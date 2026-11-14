//! 工作区配置：与 Python 版 SettingsStore 同构。
//!
//! 三条必须守住的规则：
//!   1. apiKey / token 只写入、从不回传（对外只给 apiKeySet / tokenSet）；
//!   2. 白名单合并：patch 里未知的键直接忽略，避免脏字段污染配置；
//!   3. 环境变量 TSD_LLM_* 与打包内置的 TSD_DEFAULTS_FILE 优先级高于文件。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const ENGINE_KEYS: &[&str] = &[
    "provider",
    "baseUrl",
    "model",
    "apiKey",
    "temperature",
    "maxTokens",
    "timeoutSec",
    "offlineMode",
];
pub const AGENT_KEYS: &[&str] = &[
    "mode",
    "maxSteps",
    "allowCommands",
    "verify",
    "deadlineSeconds",
    "maxObservationChars",
];
pub const W3_KEYS: &[&str] = &[
    "serverUrl",
    "loginPath",
    "modelsPath",
    "rememberUsername",
    "token",
    "user",
    "expiresAt",
    "mode",
];
pub const GIT_KEYS: &[&str] = &[
    "provider",
    "baseUrl",
    "token",
    "reposPath",
    "reposRoot",
    "defaultBranch",
    "authorName",
    "authorEmail",
];

pub fn defaults() -> Value {
    json!({
        "engine": {
            "provider": "openai-compatible",
            "baseUrl": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
            "temperature": 0.3,
            "maxTokens": 8192,
            "timeoutSec": 300,
            "offlineMode": false,
            "apiKey": "",
        },
        "agent": {
            "mode": "auto",
            "maxSteps": 24,
            "allowCommands": true,
            "verify": true,
            "deadlineSeconds": 900,
            "maxObservationChars": 6000,
        },
        "w3": {
            "serverUrl": "",
            "loginPath": "/api/v1/auth/login",
            "modelsPath": "/api/v1/models",
            "rememberUsername": "",
            "token": "",
            "user": {},
            "expiresAt": 0,
            "mode": "",
        },
        "git": {
            "provider": "local",
            "baseUrl": "",
            "token": "",
            "reposPath": "/api/v4/projects",
            "reposRoot": "",
            "defaultBranch": "main",
            "authorName": "TSD Agent",
            "authorEmail": "tsd-agent@localhost",
        },
        "concurrency": 2,
        "autoApplyChatEdits": false,
        "language": "zh-CN",
    })
}

pub fn config_path(workspace: &Path) -> PathBuf {
    workspace.join(".tsd").join("config.json")
}

fn merge_block(target: &mut Value, patch: &Value, keys: &[&str]) {
    let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in patch {
        if keys.contains(&key.as_str()) && !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

/// 读取生效配置：默认值 → 内置 defaults 文件 → 工作区 config.json → 环境变量
pub fn load(workspace: &Path) -> Value {
    let mut data = defaults();

    if let Ok(path) = std::env::var("TSD_DEFAULTS_FILE") {
        if let Some(preset) = crate::store::read_json(Path::new(&path)) {
            for (block, keys) in [
                ("engine", ENGINE_KEYS),
                ("agent", AGENT_KEYS),
                ("w3", W3_KEYS),
                ("git", GIT_KEYS),
            ] {
                if let Some(values) = preset.get(block) {
                    if let Some(target) = data.get_mut(block) {
                        merge_block(target, values, keys);
                    }
                }
            }
            for key in ["concurrency", "autoApplyChatEdits", "language"] {
                if let Some(value) = preset.get(key) {
                    data[key] = value.clone();
                }
            }
        }
    }

    if let Some(raw) = crate::store::read_json(&config_path(workspace)) {
        for (block, keys) in [
            ("engine", ENGINE_KEYS),
            ("agent", AGENT_KEYS),
            ("w3", W3_KEYS),
            ("git", GIT_KEYS),
        ] {
            if let Some(values) = raw.get(block) {
                if let Some(target) = data.get_mut(block) {
                    merge_block(target, values, keys);
                }
            }
        }
        for key in ["concurrency", "autoApplyChatEdits", "language"] {
            if let Some(value) = raw.get(key) {
                if !value.is_null() {
                    data[key] = value.clone();
                }
            }
        }
    }

    for (env_key, block, field) in [
        ("TSD_LLM_API_KEY", "engine", "apiKey"),
        ("TSD_LLM_BASE_URL", "engine", "baseUrl"),
        ("TSD_LLM_MODEL", "engine", "model"),
    ] {
        if let Ok(value) = std::env::var(env_key) {
            if !value.is_empty() {
                data[block][field] = json!(value);
            }
        }
    }
    data
}

/// 对外可见的配置：敏感字段只给布尔
pub fn public(workspace: &Path) -> Value {
    let data = load(workspace);
    let engine = &data["engine"];
    let w3 = &data["w3"];
    let git = &data["git"];
    let agent = &data["agent"];
    json!({
        "agent": {
            "mode": agent["mode"],
            "maxSteps": agent["maxSteps"],
            "allowCommands": agent["allowCommands"],
            "verify": agent["verify"],
            "deadlineSeconds": agent["deadlineSeconds"],
            "maxObservationChars": agent["maxObservationChars"],
        },
        "w3": {
            "serverUrl": w3["serverUrl"],
            "loginPath": w3["loginPath"],
            "modelsPath": w3["modelsPath"],
            "rememberUsername": w3["rememberUsername"],
            "configured": w3["serverUrl"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        },
        "git": {
            "provider": git["provider"],
            "baseUrl": git["baseUrl"],
            "tokenSet": git["token"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
            "reposPath": git["reposPath"],
            "reposRoot": git["reposRoot"],
            "defaultBranch": git["defaultBranch"],
            "authorName": git["authorName"],
            "authorEmail": git["authorEmail"],
        },
        "engine": {
            "provider": engine["provider"],
            "baseUrl": engine["baseUrl"],
            "model": engine["model"],
            "apiKeySet": engine["apiKey"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
            "temperature": engine["temperature"],
            "maxTokens": engine["maxTokens"],
            "timeoutSec": engine["timeoutSec"],
            "offlineMode": engine["offlineMode"],
        },
        "workspace": workspace.to_string_lossy(),
        "concurrency": data["concurrency"],
        "autoApplyChatEdits": data["autoApplyChatEdits"],
        "language": data["language"],
    })
}

/// 合并写入（白名单），返回对外可见结果
pub fn update(workspace: &Path, patch: &Value) -> Value {
    let mut data = load(workspace);
    let mut object: Map<String, Value> = match data.as_object_mut() {
        Some(object) => object.clone(),
        None => Map::new(),
    };

    for (block, keys) in [
        ("agent", AGENT_KEYS),
        ("w3", W3_KEYS),
        ("git", GIT_KEYS),
        ("engine", ENGINE_KEYS),
    ] {
        if let Some(values) = patch.get(block) {
            if let Some(target) = object.get_mut(block) {
                merge_block(target, values, keys);
            }
        }
    }

    // apiKey / git token：只接受非空的显式值，空串视为「不改」
    for (block, field) in [("engine", "apiKey"), ("git", "token")] {
        let incoming = patch
            .get(block)
            .and_then(|value| value.get(field))
            .and_then(Value::as_str)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        if let Some(value) = incoming {
            object[block][field] = json!(value);
        }
    }

    for key in ["concurrency", "autoApplyChatEdits", "language"] {
        if let Some(value) = patch.get(key) {
            if !value.is_null() {
                object.insert(key.to_string(), value.clone());
            }
        }
    }

    data = Value::Object(object);
    let path = config_path(workspace);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&data) {
        // 先写临时文件再改名：避免掉电/崩溃留下半截配置
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    public(workspace)
}

/// 模型是否可用（与 Python llm_available 等价）
pub fn llm_available(workspace: &Path) -> bool {
    let data = load(workspace);
    let engine = &data["engine"];
    let offline_mode = engine["offlineMode"].as_bool().unwrap_or(false)
        || engine["provider"].as_str() == Some("offline");
    if offline_mode {
        return false;
    }
    let has_key = engine["apiKey"].as_str().map(|s| !s.is_empty()).unwrap_or(false);
    let has_url = engine["baseUrl"].as_str().map(|s| !s.is_empty()).unwrap_or(false);
    has_key && has_url
}
