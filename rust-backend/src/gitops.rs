//! Git 集成：仓库检索、克隆、状态/分支/对比、提交与推送。
//!
//! 约定（与 Python 参照实现一致）：
//!   - 项目的 source/ 目录就是 git 工作区（克隆时保留 .git），升级结果在 v<version>/；
//!   - 差异计算跳过 .git，因此两者可以共存；
//!   - 发布时只同步差异涉及的文件，避免误删仓库里未被升级涉及的内容。

use std::{
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use crate::{diff, state::AppState, store};

const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
const PUSH_TIMEOUT: Duration = Duration::from_secs(300);

pub struct GitError {
    pub status: u16,
    pub message: String,
}

impl GitError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn not_a_repo() -> GitError {
    GitError::new(409, "该项目还不是 Git 仓库，请先克隆远程仓库")
}

pub fn git_available() -> bool {
    run_git(&["--version".to_string()], None, Duration::from_secs(10)).is_ok()
}

/// 识别工作区仓库（.git 目录）与裸仓库（HEAD + objects + refs）
pub fn looks_like_repo(dir: &Path) -> bool {
    if dir.join(".git").exists() {
        return true;
    }
    dir.join("HEAD").exists() && dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

/// 执行 git：内部用独立线程读管道，避免大输出把子进程堵死；超时直接 kill。
fn run_git(
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<(i32, String, String), GitError> {
    let mut command = Command::new("git");
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    let mut child = command.spawn().map_err(|_| {
        GitError::new(500, "未检测到 git 命令，请先安装 Git 并加入 PATH")
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let read_out = std::thread::spawn(move || read_all(stdout));
    let read_err = std::thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = read_out.join().unwrap_or_default();
                let err = read_err.join().unwrap_or_default();
                return Ok((status.code().unwrap_or(-1), out.trim().to_string(), err.trim().to_string()));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(GitError::new(
                        504,
                        format!("git 命令超时：{}", args.iter().take(2).cloned().collect::<Vec<_>>().join(" ")),
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(GitError::new(500, format!("执行 git 失败：{error}"))),
        }
    }
}

fn read_all(pipe: Option<impl Read + Send + 'static>) -> String {
    let Some(pipe) = pipe else {
        return String::new();
    };
    let mut buffer = Vec::new();
    let _ = BufReader::new(pipe).read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).to_string()
}

/// 成功时返回 stdout，失败返回空串（与 Python 的 _git 一致）
fn git_out(args: &[&str], cwd: &Path) -> String {
    let owned: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    match run_git(&owned, Some(cwd), GIT_TIMEOUT) {
        Ok((0, out, _)) => out,
        _ => String::new(),
    }
}

fn git_ok(args: &[&str], cwd: &Path) -> Result<String, GitError> {
    let owned: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    match run_git(&owned, Some(cwd), GIT_TIMEOUT)? {
        (0, out, _) => Ok(out),
        (_, out, err) => {
            let message = if !err.is_empty() { err } else { out };
            Err(GitError::new(
                500,
                format!("git {} 失败：{}", args.first().copied().unwrap_or(""), tail(&message, 500)),
            ))
        }
    }
}

fn tail(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    chars[chars.len() - limit..].iter().collect()
}

fn git_config(state: &AppState) -> Value {
    crate::settings::load(&state.workspace)
        .get("git")
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn as_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn author_args(cfg: &Value) -> Vec<String> {
    let name = if as_str(cfg, "authorName").is_empty() {
        "TSD Agent"
    } else {
        as_str(cfg, "authorName")
    };
    let email = if as_str(cfg, "authorEmail").is_empty() {
        "tsd-agent@localhost"
    } else {
        as_str(cfg, "authorEmail")
    };
    vec![
        "-c".to_string(),
        format!("user.name={name}"),
        "-c".to_string(),
        format!("user.email={email}"),
    ]
}

// ----------------------------------------------------------------------
// 仓库检索
// ----------------------------------------------------------------------

pub async fn search_repos(state: &AppState, prefix: &str) -> Value {
    let cfg = git_config(state);
    let provider = {
        let raw = as_str(&cfg, "provider");
        let raw = if raw.is_empty() { "local" } else { raw };
        raw.trim().to_lowercase()
    };
    let prefix = prefix.trim().to_string();
    let mut repos: Vec<Value> = Vec::new();
    let mut note = String::new();

    if matches!(provider.as_str(), "gitlab" | "github" | "generic") && !as_str(&cfg, "baseUrl").trim().is_empty() {
        match remote_repos(&provider, &cfg, &prefix).await {
            Ok(items) => repos = items,
            Err(error) => note = format!("远程仓库查询失败：{error}（已回退到本地扫描）"),
        }
    }

    for repo in local_repos(state, &cfg, &prefix) {
        let name = as_str(&repo, "name").to_string();
        if !repos.iter().any(|item| as_str(item, "name") == name) {
            repos.push(repo);
        }
    }

    if repos.is_empty() && note.is_empty() {
        note = "没有匹配的仓库。可以：1) 在设置里配置 Git 服务地址与访问令牌；\
                2) 把仓库放进本地扫描目录；3) 直接填写仓库 URL。"
            .to_string();
    }
    repos.truncate(80);
    json!({ "provider": provider, "prefix": prefix, "repos": repos, "note": note })
}

fn local_repos(state: &AppState, cfg: &Value, prefix: &str) -> Vec<Value> {
    let root_value = as_str(cfg, "reposRoot").trim().to_string();
    let root: PathBuf = if root_value.is_empty() {
        state.workspace.join("repos")
    } else {
        PathBuf::from(shellexpand_home(&root_value))
    };
    if !root.exists() {
        return Vec::new();
    }
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(&root) {
        Ok(iter) => iter.filter_map(|item| item.ok()).map(|item| item.path()).collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });

    let default_branch = {
        let value = as_str(cfg, "defaultBranch");
        if value.is_empty() { "main" } else { value }
    };
    let mut repos = Vec::new();
    for entry in entries {
        if !entry.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
            continue;
        }
        let is_repo = looks_like_repo(&entry);
        let bare = is_repo && !entry.join(".git").exists();
        let branch = if is_repo {
            if bare {
                git_out(&["symbolic-ref", "--short", "HEAD"], &entry)
            } else {
                git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &entry)
            }
        } else {
            String::new()
        };
        let updated = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_millis() as u64)
            .unwrap_or(0);
        repos.push(json!({
            "name": name,
            "fullName": name,
            "url": entry.to_string_lossy(),
            "path": entry.to_string_lossy(),
            "description": if is_repo { "本地仓库" } else { "本地目录（非 Git 仓库）" },
            "defaultBranch": if branch.is_empty() { default_branch } else { &branch },
            "updatedAt": updated,
            "provider": "local",
        }));
    }
    repos
}

fn shellexpand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    value.to_string()
}

async fn remote_repos(provider: &str, cfg: &Value, prefix: &str) -> Result<Vec<Value>, String> {
    let base = as_str(cfg, "baseUrl").trim().trim_end_matches('/').to_string();
    let token = as_str(cfg, "token").trim().to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    if provider == "gitlab" {
        let url = format!("{base}/api/v4/projects");
        let mut request = client.get(&url).header("Accept", "application/json").query(&[
            ("search", prefix),
            ("per_page", "50"),
            ("simple", "true"),
            ("order_by", "last_activity_at"),
        ]);
        if !token.is_empty() {
            request = request.header("PRIVATE-TOKEN", token);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let payload: Value = response.json().await.map_err(|error| error.to_string())?;
        let items = payload.as_array().cloned().unwrap_or_default();
        let default = {
            let value = as_str(cfg, "defaultBranch");
            if value.is_empty() { "main" } else { value }
        };
        return Ok(items
            .iter()
            .map(|item| {
                json!({
                    "name": as_str(item, "path"),
                    "fullName": first_str(item, &["path_with_namespace", "name"]),
                    "url": first_str(item, &["http_url_to_repo", "ssh_url_to_repo"]),
                    "description": as_str(item, "description"),
                    "defaultBranch": first_str_or(item, &["default_branch"], default),
                    "updatedAt": iso_to_ms(as_str(item, "last_activity_at")),
                    "provider": "gitlab",
                })
            })
            .collect());
    }

    if provider == "github" {
        let api_base = if base.is_empty() { "https://api.github.com".to_string() } else { base };
        let mut request = client
            .get(format!("{api_base}/search/repositories"))
            .header("Accept", "application/json")
            .query(&[("q", format!("{prefix} in:name")), ("per_page", "50".to_string())]);
        if !token.is_empty() {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let payload: Value = response.json().await.map_err(|error| error.to_string())?;
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        return Ok(items
            .iter()
            .map(|item| {
                json!({
                    "name": as_str(item, "name"),
                    "fullName": as_str(item, "full_name"),
                    "url": first_str(item, &["clone_url", "html_url"]),
                    "description": as_str(item, "description"),
                    "defaultBranch": first_str_or(item, &["default_branch"], "main"),
                    "updatedAt": iso_to_ms(as_str(item, "updated_at")),
                    "provider": "github",
                })
            })
            .collect());
    }

    // generic REST
    let path = {
        let value = first_str(cfg, &["reposPath"]);
        if value.is_empty() { "/api/repos".to_string() } else { value }
    };
    let url = format!("{base}{path}");
    let mut request = client
        .get(&url)
        .header("Accept", "application/json")
        .query(&[("search", prefix), ("prefix", prefix)]);
    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    let items: Vec<Value> = if payload.is_array() {
        payload.as_array().cloned().unwrap_or_default()
    } else {
        payload
            .get("items")
            .or_else(|| payload.get("data"))
            .or_else(|| payload.get("repos"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut repos = Vec::new();
    for item in items {
        let name = first_str(&item, &["name", "path"]);
        if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
            continue;
        }
        repos.push(json!({
            "name": name,
            "fullName": first_str_or(&item, &["fullName", "full_name"], &name.clone()),
            "url": first_str(&item, &["url", "cloneUrl", "clone_url"]),
            "description": as_str(&item, "description"),
            "defaultBranch": first_str_or(&item, &["defaultBranch", "default_branch"], "main"),
            "updatedAt": iso_to_ms(&first_str(&item, &["updatedAt", "updated_at"])),
            "provider": "generic",
        }));
    }
    Ok(repos)
}

fn first_str(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn first_str_or(value: &Value, keys: &[&str], fallback: &str) -> String {
    let text = first_str(value, keys);
    if text.is_empty() {
        fallback.to_string()
    } else {
        text
    }
}

// ----------------------------------------------------------------------
// 克隆
// ----------------------------------------------------------------------

pub fn clone_project(
    state: &AppState,
    project: &mut Value,
    url: &str,
    branch: Option<&str>,
) -> Result<Value, GitError> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(GitError::new(400, "缺少仓库地址"));
    }
    if !git_available() {
        return Err(GitError::new(500, "未检测到 git 命令，请先安装 Git 并加入 PATH"));
    }
    let project_id = project.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let source_dir = state.source_dir(&project_id);
    if source_dir.join(".git").exists() {
        return Err(GitError::new(409, "该项目的代码目录已经是 Git 工作区，无需重复克隆"));
    }
    if source_dir.exists() {
        let _ = std::fs::remove_dir_all(&source_dir);
    }
    if let Some(parent) = source_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let local_path = PathBuf::from(shellexpand_home(&url));
    if local_path.exists() && local_path.is_dir() {
        if looks_like_repo(&local_path) {
            clone_local_repo(&local_path, &source_dir)?;
        } else {
            copy_tree(&local_path, &source_dir);
            init_local_repo(state, &source_dir);
        }
    } else {
        clone_remote(state, &url, &source_dir, branch)?;
    }

    let detected = store::detect_version(&source_dir);
    if let Some(object) = project.as_object_mut() {
        object.insert("sourceUrl".to_string(), json!(url));
        object.insert("sourceKind".to_string(), json!("git"));
        if let Some(version) = &detected {
            object.insert("baseVersion".to_string(), json!(version));
        }
    }
    let _ = crate::projects::save(&state.workspace, project);

    let head = git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &source_dir);
    Ok(json!({
        "ok": true,
        "branch": if head.is_empty() { branch.unwrap_or("").to_string() } else { head },
        "remote": git_out(&["remote", "get-url", "origin"], &source_dir),
        "files": store::walk_files(&source_dir).len(),
        "baseVersion": detected,
    }))
}

fn clone_local_repo(source: &Path, dest: &Path) -> Result<(), GitError> {
    let _ = std::fs::create_dir_all(dest);
    let args = vec![
        "clone".to_string(),
        "--quiet".to_string(),
        source.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    ];
    match run_git(&args, dest.parent(), CLONE_TIMEOUT)? {
        (0, _, _) => Ok(()),
        (_, _, err) => Err(GitError::new(500, format!("克隆本地仓库失败：{}", tail(&err, 300)))),
    }
}

fn clone_remote(state: &AppState, url: &str, dest: &Path, branch: Option<&str>) -> Result<(), GitError> {
    let cfg = git_config(state);
    let token = as_str(&cfg, "token").trim().to_string();
    let mut args: Vec<String> = vec!["git".to_string()];
    if !token.is_empty() && url.starts_with("https://") {
        args.push("-c".to_string());
        args.push(format!("http.extraheader=Authorization: Bearer {token}"));
    }
    args.push("clone".to_string());
    args.push("--quiet".to_string());
    args.push("--depth".to_string());
    args.push("50".to_string());
    if let Some(branch) = branch {
        if !branch.is_empty() {
            args.push("--branch".to_string());
            args.push(branch.to_string());
        }
    }
    args.push(url.to_string());
    args.push(dest.to_string_lossy().to_string());
    // 第一个参数是 "git" 本身（占位），run_git 需要去掉
    let args: Vec<String> = args.into_iter().skip(1).collect();
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match run_git(&args, dest.parent(), CLONE_TIMEOUT)? {
        (0, _, _) => Ok(()),
        (_, _, err) => {
            let hint = if err.contains("Authentication") || err.contains("403") {
                "（私有仓库请先在设置中配置 Git 访问令牌）"
            } else {
                ""
            };
            Err(GitError::new(502, format!("克隆失败：{}{}", tail(&err, 400), hint)))
        }
    }
}

fn init_local_repo(state: &AppState, directory: &Path) {
    let cfg = git_config(state);
    let branch = {
        let value = as_str(&cfg, "defaultBranch");
        if value.is_empty() { "main".to_string() } else { value.to_string() }
    };
    let _ = run_git(
        &["init".to_string(), "-b".to_string(), branch],
        Some(directory),
        GIT_TIMEOUT,
    );
    let _ = run_git(&["add".to_string(), "-A".to_string()], Some(directory), GIT_TIMEOUT);
    let mut args = author_args(&cfg);
    args.extend([
        "commit".to_string(),
        "--quiet".to_string(),
        "-m".to_string(),
        "chore: import local sources".to_string(),
    ]);
    let _ = run_git(&args, Some(directory), GIT_TIMEOUT);
}

fn copy_tree(from: &Path, to: &Path) -> usize {
    let mut count = 0;
    let files = store::walk_files(from);
    for rel in files.keys() {
        let source = from.join(rel);
        let dest = to.join(rel);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&source, &dest).is_ok() {
            count += 1;
        }
    }
    count
}

// ----------------------------------------------------------------------
// 状态 / 分支 / 对比
// ----------------------------------------------------------------------

fn repo_dir(state: &AppState, project: &Value) -> Result<PathBuf, GitError> {
    let id = project.get("id").and_then(Value::as_str).unwrap_or_default();
    let repo = state.source_dir(id);
    if !repo.join(".git").exists() {
        return Err(not_a_repo());
    }
    Ok(repo)
}

pub fn status(state: &AppState, project: &Value) -> Value {
    let id = project.get("id").and_then(Value::as_str).unwrap_or_default();
    let repo = state.source_dir(id);
    let source_url = project.get("sourceUrl").and_then(Value::as_str).unwrap_or("").to_string();
    if !repo.join(".git").exists() {
        return json!({
            "initialized": false,
            "repoDir": repo.to_string_lossy(),
            "gitAvailable": git_available(),
            "sourceUrl": source_url,
        });
    }

    let branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &repo);
    let remote_url = git_out(&["remote", "get-url", "origin"], &repo);
    let upstream = git_out(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], &repo);
    let (mut ahead, mut behind) = (0u64, 0u64);
    if !upstream.is_empty() {
        let counts = git_out(
            &["rev-list", "--left-right", "--count", &format!("{upstream}...HEAD")],
            &repo,
        );
        let parts: Vec<&str> = counts.split_whitespace().collect();
        if parts.len() == 2 {
            behind = parts[0].parse().unwrap_or(0);
            ahead = parts[1].parse().unwrap_or(0);
        }
    }

    let mut dirty: Vec<Value> = Vec::new();
    for line in git_out(&["status", "--porcelain=v1"], &repo).lines() {
        if line.chars().count() < 4 {
            continue;
        }
        let code = line.chars().take(2).collect::<String>().trim().to_string();
        let path = line.chars().skip(3).collect::<String>().trim().trim_matches('"').to_string();
        dirty.push(json!({
            "path": path,
            "status": porcelain_status(if code.is_empty() { "?" } else { &code }),
        }));
    }

    let log_line = git_out(&["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI"], &repo);
    let mut last_commit = Value::Null;
    if !log_line.is_empty() {
        let parts: Vec<&str> = log_line.split('\u{1f}').collect();
        if parts.len() == 4 {
            last_commit = json!({
                "sha": parts[0],
                "message": parts[1],
                "author": parts[2],
                "date": parts[3],
            });
        }
    }

    let mut remotes: Vec<Value> = Vec::new();
    for line in git_out(&["remote", "-v"], &repo).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 2 && !remotes.iter().any(|item| as_str(item, "name") == fields[0]) {
            remotes.push(json!({ "name": fields[0], "url": fields[1] }));
        }
    }

    json!({
        "initialized": true,
        "repoDir": repo.to_string_lossy(),
        "gitAvailable": true,
        "branch": branch,
        "upstream": upstream,
        "remoteUrl": remote_url,
        "remotes": remotes,
        "ahead": ahead,
        "behind": behind,
        "dirty": dirty,
        "lastCommit": last_commit,
        "sourceUrl": source_url,
    })
}

pub fn branches(state: &AppState, project: &Value) -> Result<Value, GitError> {
    let repo = repo_dir(state, project)?;
    let current = git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &repo);
    let parse = |reference: &str| -> Vec<Value> {
        let mut items = Vec::new();
        let format = "--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:iso8601)%1f%(subject)";
        let output = git_out(&["for-each-ref", format, reference], &repo);
        for line in output.lines() {
            let parts: Vec<&str> = line.split('\u{1f}').collect();
            if parts.len() >= 4 {
                items.push(json!({
                    "name": parts[0],
                    "sha": parts[1],
                    "date": parts[2],
                    "subject": parts[3],
                }));
            }
        }
        items
    };
    Ok(json!({
        "current": current,
        "local": parse("refs/heads"),
        "remote": parse("refs/remotes"),
    }))
}

pub fn compare(state: &AppState, project: &Value, base: Option<&str>) -> Result<Value, GitError> {
    let repo = repo_dir(state, project)?;
    let cfg = git_config(state);
    let mut fetched = false;
    if !git_out(&["remote"], &repo).is_empty() {
        if let Ok((code, _, _)) = run_git(
            &[
                "fetch".to_string(),
                "--all".to_string(),
                "--prune".to_string(),
                "--quiet".to_string(),
            ],
            Some(&repo),
            Duration::from_secs(90),
        ) {
            fetched = code == 0;
        }
    }

    let branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &repo);
    let default_branch = {
        let value = as_str(&cfg, "defaultBranch");
        if value.is_empty() { "main".to_string() } else { value.to_string() }
    };
    let mut candidates: Vec<String> = Vec::new();
    if let Some(base) = base {
        if !base.trim().is_empty() {
            candidates.push(base.trim().to_string());
        }
    }
    candidates.push("@{u}".to_string());
    if !branch.is_empty() && branch != "HEAD" {
        candidates.push(format!("origin/{branch}"));
    }
    candidates.push(format!("origin/{default_branch}"));
    candidates.push("origin/HEAD".to_string());
    candidates.push("HEAD~0".to_string());

    let mut resolved = String::new();
    for candidate in &candidates {
        if !git_out(&["rev-parse", "--verify", "--quiet", candidate], &repo).is_empty() {
            resolved = candidate.clone();
            break;
        }
    }

    if resolved.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "no-base",
            "branch": branch,
            "note": "没有可对比的远程分支，请先 git fetch 或配置默认分支",
            "fetched": fetched,
        }));
    }

    let counts = git_out(
        &["rev-list", "--left-right", "--count", &format!("{resolved}...HEAD")],
        &repo,
    );
    let parts: Vec<&str> = counts.split_whitespace().collect();
    let (behind, ahead) = if parts.len() == 2 {
        (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
    } else {
        (0u64, 0u64)
    };

    let commits = |spec: String| -> Vec<Value> {
        let mut items = Vec::new();
        let output = git_out(&["log", "--oneline", "--no-decorate", "--max-count=30", &spec], &repo);
        for line in output.lines() {
            let (sha, subject) = line.split_once(' ').unwrap_or((line, ""));
            items.push(json!({ "sha": sha, "subject": subject }));
        }
        items
    };

    let mut files: Vec<Value> = Vec::new();
    for line in git_out(&["diff", "--name-status", &format!("{resolved}...HEAD")], &repo).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            files.push(json!({
                "status": name_status(parts[0]),
                "path": parts[parts.len() - 1],
            }));
        }
    }

    Ok(json!({
        "ok": true,
        "base": resolved,
        "branch": branch,
        "fetched": fetched,
        "ahead": ahead,
        "behind": behind,
        "commits": commits(format!("{resolved}..HEAD")),
        "incoming": commits(format!("HEAD..{resolved}")),
        "files": files,
    }))
}

// ----------------------------------------------------------------------
// 提交与推送
// ----------------------------------------------------------------------

pub fn publish(
    state: &AppState,
    project: &Value,
    message: &str,
    branch: &str,
    push: bool,
    remote: &str,
    create_branch: bool,
    force: bool,
) -> Result<Value, GitError> {
    let repo = repo_dir(state, project)?;
    let target = state.target_dir(project);
    if !target.exists() {
        return Err(GitError::new(409, "还没有升级结果，请先执行一次升级"));
    }
    let target_version = project
        .get("targetVersion")
        .and_then(Value::as_str)
        .unwrap_or("next");
    let branch = if branch.trim().is_empty() {
        format!("upgrade/v{target_version}")
    } else {
        branch.trim().to_string()
    };
    let message = if message.trim().is_empty() {
        format!("feat: upgrade to v{target_version}")
    } else {
        message.trim().to_string()
    };
    let remote = if remote.trim().is_empty() { "origin" } else { remote.trim() };

    let dirty: Vec<String> = git_out(&["status", "--porcelain=v1"], &repo)
        .lines()
        .filter(|line| line.chars().count() > 3)
        .map(|line| line.chars().skip(3).collect::<String>().trim().to_string())
        .collect();
    if !dirty.is_empty() && !force {
        let sample: Vec<String> = dirty.iter().take(50).cloned().collect();
        return Ok(json!({
            "ok": false,
            "reason": "worktree-dirty",
            "branch": branch,
            "dirty": sample,
            "note": "工作区有未提交改动；确认覆盖请再次提交并勾选强制覆盖",
        }));
    }

    if create_branch {
        git_ok(&["checkout", "-B", &branch], &repo)?;
    } else if !git_out(&["rev-parse", "--verify", "--quiet", &branch], &repo).is_empty() {
        git_ok(&["checkout", &branch], &repo)?;
    } else {
        git_ok(&["checkout", "-b", &branch], &repo)?;
    }

    // 只同步差异涉及的文件，避免误删仓库里未参与升级的内容
    let source_dir = state.source_dir(
        project.get("id").and_then(Value::as_str).unwrap_or_default(),
    );
    let file_diff = diff::compute_diffs(&source_dir, &target);
    let mut changed: Vec<Value> = Vec::new();
    {
        for entry in &file_diff.files {
            let rel = entry.path.as_str();
            let status = entry.status.as_str();
            if rel.is_empty() {
                continue;
            }
            if status == "deleted" {
                let victim = repo.join(rel);
                if victim.exists() {
                    let _ = std::fs::remove_file(&victim);
                }
                changed.push(json!({ "path": rel, "status": "deleted" }));
                continue;
            }
            let src = target.join(rel);
            if !src.exists() {
                continue;
            }
            let dst = repo.join(rel);
            if let Some(parent) = dst.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::copy(&src, &dst)
                .map_err(|error| GitError::new(500, format!("同步文件失败：{rel}（{error}）")))?;
            changed.push(json!({ "path": rel, "status": status }));
        }
    }

    git_ok(&["add", "-A"], &repo)?;
    if git_out(&["status", "--porcelain=v1"], &repo).trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": "no-changes",
            "branch": branch,
            "files": changed,
            "note": "升级结果与当前分支内容一致，没有需要提交的改动",
        }));
    }

    let cfg = git_config(state);
    let mut commit_args = author_args(&cfg);
    commit_args.extend([
        "commit".to_string(),
        "--quiet".to_string(),
        "-m".to_string(),
        message.clone(),
    ]);
    match run_git(&commit_args, Some(&repo), GIT_TIMEOUT)? {
        (0, _, _) => {}
        (_, out, err) => {
            let text = if err.is_empty() { out } else { err };
            return Err(GitError::new(500, format!("提交失败：{}", tail(&text, 400))));
        }
    }
    let sha = git_out(&["rev-parse", "--short", "HEAD"], &repo);

    let mut result = json!({
        "ok": true,
        "branch": branch,
        "sha": sha,
        "files": changed,
        "pushed": false,
        "remote": remote,
        "note": "",
    });

    if push {
        let token = as_str(&cfg, "token").trim().to_string();
        let remote_url = git_out(&["remote", "get-url", remote], &repo);
        let mut args: Vec<String> = Vec::new();
        if !token.is_empty() && remote_url.starts_with("https://") {
            args.push("-c".to_string());
            args.push(format!("http.extraheader=Authorization: Bearer {token}"));
        }
        args.extend([
            "push".to_string(),
            "-u".to_string(),
            remote.to_string(),
            branch.clone(),
        ]);
        match run_git(&args, Some(&repo), PUSH_TIMEOUT)? {
            (0, _, _) => {
                result["pushed"] = json!(true);
                let url = web_url(&remote_url, &branch);
                if !url.is_empty() {
                    result["url"] = json!(url);
                }
            }
            (_, out, err) => {
                let text = if err.is_empty() { out } else { err };
                result["ok"] = json!(false);
                result["reason"] = json!("push-failed");
                result["error"] = json!(tail(&text, 600));
                result["note"] = json!("提交已在本地完成，推送失败；可配置访问令牌后重试推送");
            }
        }
    }
    Ok(result)
}

pub fn push(state: &AppState, project: &Value, branch: &str, remote: &str) -> Result<Value, GitError> {
    let repo = repo_dir(state, project)?;
    let cfg = git_config(state);
    let remote = if remote.trim().is_empty() { "origin" } else { remote.trim() };
    let token = as_str(&cfg, "token").trim().to_string();
    let remote_url = git_out(&["remote", "get-url", remote], &repo);
    let mut args: Vec<String> = Vec::new();
    if !token.is_empty() && remote_url.starts_with("https://") {
        args.push("-c".to_string());
        args.push(format!("http.extraheader=Authorization: Bearer {token}"));
    }
    args.extend([
        "push".to_string(),
        "-u".to_string(),
        remote.to_string(),
        branch.to_string(),
    ]);
    match run_git(&args, Some(&repo), PUSH_TIMEOUT)? {
        (0, _, _) => Ok(json!({
            "ok": true,
            "branch": branch,
            "remote": remote,
            "url": web_url(&remote_url, branch),
        })),
        (_, out, err) => {
            let text = if err.is_empty() { out } else { err };
            Err(GitError::new(502, format!("推送失败：{}", tail(&text, 500))))
        }
    }
}

fn porcelain_status(code: &str) -> &'static str {
    if code.starts_with('?') {
        "untracked"
    } else if code.contains('D') {
        "deleted"
    } else if code.contains('R') {
        "renamed"
    } else if code.contains('A') {
        "added"
    } else {
        "modified"
    }
}

fn name_status(code: &str) -> &'static str {
    if code.starts_with('A') {
        "added"
    } else if code.starts_with('D') {
        "deleted"
    } else if code.starts_with('R') {
        "renamed"
    } else {
        "modified"
    }
}

fn iso_to_ms(value: &str) -> u64 {
    if value.trim().is_empty() {
        return 0;
    }
    // 只处理最常见的 RFC3339（2026-01-02T03:04:05Z / +08:00）
    let text = value.trim().replace('Z', "+00:00");
    let (body, offset_minutes) = if let Some((head, tail)) = text.rsplit_once('+') {
        (head.to_string(), parse_offset(tail))
    } else if let Some((head, tail)) = text.rsplit_once('-') {
        if tail.contains(':') {
            (head.to_string(), -parse_offset(tail))
        } else {
            (text.clone(), 0)
        }
    } else {
        (text.clone(), 0)
    };
    let body = body.replace(' ', "T");
    let mut parts = body.split(['T', '-', ':']);
    let mut numbers: Vec<i64> = Vec::new();
    while let Some(part) = parts.next() {
        let cleaned: String = part.chars().take(2).collect();
        match cleaned.parse::<i64>() {
            Ok(value) => numbers.push(value),
            Err(_) => break,
        }
        if numbers.len() >= 6 {
            break;
        }
    }
    if numbers.len() < 6 {
        return 0;
    }
    let (year, month, day, hour, minute, second) = (
        numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5],
    );
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    if seconds < 0 {
        return 0;
    }
    (seconds as u64) * 1000
}

fn parse_offset(text: &str) -> i64 {
    let value: String = text.chars().take(5).collect();
    let mut parts = value.split(':');
    let hours: i64 = parts.next().and_then(|item| item.parse().ok()).unwrap_or(0);
    let minutes: i64 = parts.next().and_then(|item| item.parse().ok()).unwrap_or(0);
    hours * 60 + minutes
}

/// 公历日期 → Unix 天数（Howard Hinnant 的算法，避免引入 chrono）
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn web_url(remote_url: &str, branch: &str) -> String {
    let mut url = remote_url.trim().to_string();
    if url.is_empty() {
        return String::new();
    }
    if url.ends_with(".git") {
        url.truncate(url.len() - 4);
    }
    if url.starts_with("git@") {
        if let Some((host, path)) = url.split_once(':') {
            url = format!("https://{}/{}", host.replace("git@", ""), path);
        }
    }
    if url.starts_with("http") {
        let encoded = urlencoding(branch);
        if !url.contains("/-/") && url.contains("gitlab") {
            return format!("{url}/-/tree/{encoded}");
        }
        return format!("{url}/tree/{encoded}");
    }
    String::new()
}

fn urlencoding(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}
