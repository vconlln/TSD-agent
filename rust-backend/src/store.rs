use std::{
    collections::BTreeMap,
    fs,
    path::Path,
};

use serde_json::Value;

/// 与 Python 参照实现一致的忽略目录（避免把 node_modules / dist 之类算进差异）
const SKIP_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build",
    "out", ".next", ".nuxt", ".cache", "target", "coverage", ".idea", ".vscode", ".dsh",
    ".hallmark", "release", "backend-dist",
];

const MAX_FILES: usize = 6000;

pub fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read_text(path: &Path, limit: usize) -> (String, bool) {
    match fs::read(path) {
        Ok(bytes) => {
            let truncated = bytes.len() > limit;
            let slice = if truncated { &bytes[..limit] } else { &bytes[..] };
            (String::from_utf8_lossy(slice).to_string(), truncated)
        }
        Err(_) => (String::new(), false),
    }
}

pub fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_binary(path: &Path) -> bool {
    use std::io::Read;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "pdf" | "zip" | "gz" | "tar" | "7z"
            | "exe" | "dll" | "so" | "dylib" | "woff" | "woff2" | "ttf" | "otf" | "mp4" | "mp3"
            | "wasm" | "class" | "jar" | "bin"
    ) {
        return true;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 8192];
    let read = file.read(&mut head).unwrap_or(0);
    head[..read].contains(&0)
}

pub fn language_of(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    let lang = match ext.as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "csharp",
        "cpp" | "cc" | "hpp" | "h" => "cpp",
        "c" => "c",
        "swift" => "swift",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" => "markdown",
        "css" => "css",
        "scss" => "scss",
        "html" | "htm" => "html",
        "sh" | "bash" => "shell",
        "sql" => "sql",
        "vue" => "vue",
        "svelte" => "svelte",
        other => other,
    };
    lang.to_string()
}

/// 遍历目录，返回「相对路径(POSIX) → 文件大小」；与 Python 版 walk_files 的忽略规则一致。
pub fn walk_files(root: &Path) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    if !root.exists() {
        return out;
    }
    let mut count = 0usize;
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_dir() {
                return !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with(".tsd");
            }
            name != ".DS_Store" && name != "Thumbs.db"
        });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if count >= MAX_FILES {
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.insert(rel_str, size);
        count += 1;
    }
    out
}

pub fn list_project_ids(workspace_projects: &Path) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let Ok(entries) = fs::read_dir(workspace_projects) else {
        return ids;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if entry.path().join("project.json").exists() {
            ids.push(id);
        }
    }
    ids
}

/// 前端文件树的状态映射：来自 diff.json 的 files[].status
pub fn status_map(diff: &Value) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Some(files) = diff.get("files").and_then(Value::as_array) {
        for file in files {
            if let (Some(path), Some(status)) = (
                file.get("path").and_then(Value::as_str),
                file.get("status").and_then(Value::as_str),
            ) {
                map.insert(path.to_string(), status.to_string());
            }
        }
    }
    map
}

pub fn hashed(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let Ok(bytes) = fs::read(path) else { return 0 };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}


