//! 项目读写：创建 / 补丁 / 删除，字段与 Python 参照实现保持一致。

use std::{fs, path::PathBuf};

use serde_json::{json, Value};

use crate::{events::now_ms, runs::random_id, store};

pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            if !slug.ends_with('-') {
                slug.push('-');
            }
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed
    }
}

pub fn bump_version(version: &str, level: &str) -> String {
    let mut parts: Vec<u64> = version
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    while parts.len() < 3 {
        parts.push(0);
    }
    match level {
        "major" => {
            parts[0] += 1;
            parts[1] = 0;
            parts[2] = 0;
        }
        "patch" => {
            parts[2] += 1;
        }
        _ => {
            parts[1] += 1;
            parts[2] = 0;
        }
    }
    format!("{}.{}.{}", parts[0], parts[1], parts[2])
}

pub fn project_dir(workspace: &std::path::Path, id: &str) -> PathBuf {
    workspace.join("projects").join(id)
}

/// 创建项目：默认 baseVersion 1.0.0，targetVersion 缺省时按 minor 递增
pub fn create(
    workspace: &std::path::Path,
    name: &str,
    source_url: &str,
    source_kind: &str,
    target_version: &str,
    description: &str,
) -> Value {
    let id = random_id();
    let slug = slugify(name);
    let base_version = "1.0.0".to_string();
    let target = if target_version.trim().is_empty() {
        bump_version(&base_version, "minor")
    } else {
        target_version.trim().to_string()
    };
    let dir = project_dir(workspace, &id);
    let _ = fs::create_dir_all(dir.join("plan"));
    let _ = fs::create_dir_all(dir.join("runs"));
    let project = json!({
        "id": id,
        "name": if name.trim().is_empty() { slug.clone() } else { name.trim().to_string() },
        "slug": slug,
        "sourceUrl": source_url,
        "sourceKind": if source_kind.is_empty() { "page" } else { source_kind },
        "baseVersion": base_version,
        "targetVersion": target,
        "status": "draft",
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "workspace": dir.to_string_lossy(),
        "description": description,
        "tags": [],
        "stats": { "files": 0, "added": 0, "removed": 0, "sections": 0, "filesChanged": 0 },
    });
    let _ = save(workspace, &project);
    project
}

pub fn save(workspace: &std::path::Path, project: &Value) -> std::io::Result<()> {
    let Some(id) = project.get("id").and_then(Value::as_str) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "缺少 id"));
    };
    let dir = project_dir(workspace, id);
    fs::create_dir_all(&dir)?;
    let text = serde_json::to_string_pretty(project).unwrap_or_else(|_| "{}".to_string());
    fs::write(dir.join("project.json"), text)
}

pub fn load(workspace: &std::path::Path, id: &str) -> Option<Value> {
    store::read_json(&project_dir(workspace, id).join("project.json"))
}

pub fn patch(workspace: &std::path::Path, id: &str, patch: &Value) -> Option<Value> {
    let mut project = load(workspace, id)?;
    if let (Some(target), Some(object)) = (project.as_object_mut(), patch.as_object()) {
        for (key, value) in object {
            if value.is_null() {
                continue;
            }
            if matches!(
                key.as_str(),
                "name" | "description" | "targetVersion" | "baseVersion" | "tags" | "status" | "error"
            ) {
                target.insert(key.clone(), value.clone());
            }
        }
        target.insert("updatedAt".to_string(), json!(now_ms()));
    }
    let _ = save(workspace, &project);
    Some(project)
}

pub fn delete(workspace: &std::path::Path, id: &str) -> bool {
    let dir = project_dir(workspace, id);
    if dir.exists() {
        fs::remove_dir_all(dir).is_ok()
    } else {
        false
    }
}
