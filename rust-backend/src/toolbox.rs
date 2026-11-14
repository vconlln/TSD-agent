//! Agent 的「手」：在沙箱内读写文件、搜索、执行验证命令。
//!
//! 所有路径都限制在升级结果目录内；命令有白名单、超时与输出上限。
//! 工具返回的是「观察结果」，会作为下一条消息回喂给模型——这是 Agent 能自我纠错的关键。

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::{json, Value};

use crate::{repomap, store};

const MAX_READ_LINES: usize = 400;
const MAX_WRITE_BYTES: usize = 800_000;
const MAX_GREP_MATCHES: usize = 100;
const MAX_SCAN_BYTES: u64 = 500_000;

const ALLOWED_PROGRAMS: &[&str] = &[
    "python", "python3", "py", "pytest", "uv", "pip", "pip3", "npm", "npx", "pnpm", "yarn",
    "node", "bun", "deno", "go", "cargo", "rustc", "make", "cmake", "ninja", "tsc", "eslint",
    "prettier", "jest", "vitest", "mocha", "ruff", "black", "mypy", "pyright", "flake8", "javac",
    "java", "mvn", "gradle", "gradlew", "dotnet", "php", "composer", "ruby", "bundle", "rake",
    "dart", "flutter", "gcc", "g++", "clang", "clang++", "zig", "swift",
];

const DENY_PATTERNS: &[&str] = &[
    r"\bsudo\b",
    r"\brm\s+-[a-z]*[rf]",
    r"\bmkfs\b",
    r"\bdd\s+if=",
    r"\bshutdown\b",
    r"\breboot\b",
    r">\s*/dev/",
    r"\bchmod\s+-R\b",
    r"\bchown\s+-R\b",
    r"\bgit\s+(push|commit|reset|checkout|clean)\b",
    r"\bcurl\b[^|]*\|\s*(sh|bash)",
    r"\bwget\b[^|]*\|\s*(sh|bash)",
    r"\b(sh|bash)\s+-c\b.*\|\s*(sh|bash)",
];

/// OpenAI function calling 的工具声明（描述里写清使用时机，模型才用得对）
pub fn tool_specs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "按 glob 列出仓库里的文件（相对于项目根目录）。用于确认目录结构与文件是否存在。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "glob，例如 src/**/*.ts；默认 **/*" },
                        "limit": { "type": "integer", "description": "最多返回多少条，默认 200" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取文件内容（带行号）。修改前必须先读，确保后续 edit_file 的 old_string 与文件完全一致。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "相对路径，例如 src/auth.ts" },
                        "start_line": { "type": "integer", "description": "起始行，默认 1" },
                        "end_line": { "type": "integer", "description": "结束行，默认根据文件长度" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "按正则搜索文件内容，返回 路径:行号: 内容。用于定位符号、配置项、旧实现。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "正则表达式" },
                        "include": { "type": "string", "description": "可选 glob 过滤，例如 *.ts" },
                        "limit": { "type": "integer", "description": "最多匹配数，默认 80" }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "把文件中一段完全一致的文本替换为新文本。old_string 必须唯一（否则需提供更多上下文或设 replace_all）。改完请回读确认。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string", "description": "要替换的原文，需与文件内容逐字一致（含缩进）" },
                        "new_string": { "type": "string", "description": "替换后的文本" },
                        "replace_all": { "type": "boolean", "description": "是否替换所有匹配，默认 false" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "写入（覆盖）整个文件。仅用于新建文件，或整文件重写；局部修改优先用 edit_file。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "删除一个文件（相对路径）。",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "在项目根目录执行一条构建/测试/检查命令（白名单：npm/pytest/go/cargo/tsc/ruff 等）。用于验证改动是否可用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "例如 npm test 或 python -m pytest -q" },
                        "timeout_seconds": { "type": "integer", "description": "超时秒数，默认 120，上限 600" }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_tests",
                "description": "自动探测并运行项目测试命令（package.json scripts.test / pytest / go test / cargo test）。",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "finish",
                "description": "任务完成时调用，给出中文总结：改了哪些文件、为什么、验证结果如何。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": { "type": "string", "description": "改动总结与验证结论" },
                        "changed_files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "本次改动的文件列表"
                        }
                    },
                    "required": ["summary"]
                }
            }
        }
    ])
}

pub struct ToolResult {
    pub ok: bool,
    pub content: String,
    pub meta: Value,
}

impl ToolResult {
    fn ok(content: impl Into<String>) -> Self {
        Self {
            ok: true,
            content: content.into(),
            meta: json!({}),
        }
    }

    fn fail(content: impl Into<String>) -> Self {
        Self {
            ok: false,
            content: content.into(),
            meta: json!({}),
        }
    }
}

pub struct Toolbox {
    pub root: PathBuf,
    pub allow_commands: bool,
    pub max_output: usize,
    pub default_timeout: u64,
    pub changed_files: Vec<String>,
    pub finished: bool,
    pub summary: String,
}

impl Toolbox {
    pub fn new(root: &Path, allow_commands: bool, max_output: usize) -> Self {
        Self {
            root: root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
            allow_commands,
            max_output,
            default_timeout: 120,
            changed_files: Vec::new(),
            finished: false,
            summary: String::new(),
        }
    }

    fn remember(&mut self, path: &Path) {
        if let Ok(rel) = path.strip_prefix(&self.root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !self.changed_files.contains(&rel) {
                self.changed_files.push(rel);
            }
        }
    }

    /// 路径沙箱：解析到 root 内，越界直接拒绝
    fn resolve(&self, raw: &str) -> Result<PathBuf, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("缺少路径".to_string());
        }
        let candidate = self
            .root
            .join(trimmed.trim_start_matches(['/', '\\']));
        let normalized = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if !normalized.starts_with(&self.root) {
            return Err(format!("路径越界：{raw}"));
        }
        Ok(normalized)
    }

    fn truncate(&self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() <= self.max_output {
            return text.to_string();
        }
        let head: String = chars[..self.max_output / 3].iter().collect();
        let tail: String = chars[chars.len() - self.max_output / 3..].iter().collect();
        format!("{head}\n…（输出过长已截断）…\n{tail}")
    }

    pub async fn call(&mut self, name: &str, args: &Value) -> ToolResult {
        let empty = json!({});
        let args = if args.is_object() { args } else { &empty };
        match name {
            "list_files" => self.list_files(args),
            "read_file" => self.read_file(args),
            "grep" => self.grep(args),
            "edit_file" => self.edit_file(args),
            "write_file" => self.write_file(args),
            "delete_file" => self.delete_file(args),
            "run_command" => self.run_command(args).await,
            "run_tests" => self.run_tests().await,
            "finish" => self.finish(args),
            other => ToolResult::fail(format!("未知工具：{other}")),
        }
    }

    fn list_files(&self, args: &Value) -> ToolResult {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or("**/*")
            .trim()
            .to_string();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .min(500) as usize;
        let mut results: Vec<String> = Vec::new();
        for (rel, size) in store::walk_files(&self.root) {
            if !glob_match(&pattern, &rel) {
                continue;
            }
            if rel.starts_with(".git/") || rel.contains("node_modules/") {
                continue;
            }
            results.push(format!("{rel} ({size} B)"));
            if results.len() >= limit {
                break;
            }
        }
        if results.is_empty() {
            return ToolResult::ok(format!("没有匹配 {pattern} 的文件"));
        }
        ToolResult::ok(results.join("\n"))
    }

    fn read_file(&self, args: &Value) -> ToolResult {
        let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
        let path = match self.resolve(raw) {
            Ok(path) => path,
            Err(error) => return ToolResult::fail(format!("参数错误：{error}")),
        };
        if !path.is_file() {
            return ToolResult::fail(format!("文件不存在：{raw}"));
        }
        if store::is_binary(&path) {
            return ToolResult::fail("二进制文件无法读取");
        }
        let (text, truncated) = store::read_text(&path, 1_500_000);
        let lines: Vec<&str> = text.split('\n').collect();
        let total = lines.len();
        let start = args
            .get("start_line")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let requested_end = args.get("end_line").and_then(Value::as_u64).unwrap_or(0) as usize;
        let end = if requested_end == 0 { total } else { requested_end }
            .max(start)
            .min(total)
            .min(start + MAX_READ_LINES - 1);
        let body: Vec<String> = (start..=end)
            .map(|number| format!("{:>5}| {}", number, lines[number - 1]))
            .collect();
        let mut note = String::new();
        if truncated {
            note.push_str("\n…（文件过大，仅读取前 1.5MB）");
        }
        if end < total {
            note.push_str(&format!("\n…（共 {total} 行，已显示到第 {end} 行，可再次调用读取后续）"));
        }
        ToolResult::ok(format!("{raw}（{start}-{end}/{total} 行）\n{}{note}", body.join("\n")))
    }

    fn grep(&self, args: &Value) -> ToolResult {
        let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
        if pattern.is_empty() {
            return ToolResult::fail("缺少 pattern");
        }
        let Ok(regex) = regex::Regex::new(pattern) else {
            return ToolResult::fail("正则不合法");
        };
        let include = args.get("include").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(80)
            .min(MAX_GREP_MATCHES as u64) as usize;
        let mut matches: Vec<String> = Vec::new();
        for (rel, size) in store::walk_files(&self.root) {
            if size > MAX_SCAN_BYTES {
                continue;
            }
            if !include.is_empty() && !glob_match(&include, &rel) {
                continue;
            }
            let path = self.root.join(&rel);
            if store::is_binary(&path) {
                continue;
            }
            let (text, _) = store::read_text(&path, MAX_SCAN_BYTES as usize);
            if text.is_empty() {
                continue;
            }
            for (number, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    let snippet: String = line.trim().chars().take(200).collect();
                    matches.push(format!("{}:{}: {snippet}", rel, number + 1));
                    if matches.len() >= limit {
                        break;
                    }
                }
            }
            if matches.len() >= limit {
                break;
            }
        }
        if matches.is_empty() {
            return ToolResult::ok(format!("没有匹配 /{pattern}/ 的内容"));
        }
        ToolResult::ok(matches.join("\n"))
    }

    fn edit_file(&mut self, args: &Value) -> ToolResult {
        let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
        let path = match self.resolve(raw) {
            Ok(path) => path,
            Err(error) => return ToolResult::fail(format!("参数错误：{error}")),
        };
        if !path.exists() {
            return ToolResult::fail(format!("文件不存在：{raw}（新建文件请用 write_file）"));
        }
        let old = args.get("old_string").and_then(Value::as_str).unwrap_or("");
        let new = args.get("new_string").and_then(Value::as_str).unwrap_or("");
        if old.is_empty() {
            return ToolResult::fail("old_string / new_string 必填");
        }
        if old == new {
            return ToolResult::fail("old_string 与 new_string 相同，没有改动");
        }
        let (text, _) = store::read_text(&path, 1_500_000);
        let count = text.matches(old).count();
        if count == 0 {
            let hint = nearest_line_hint(&text, old);
            let mut message = "未找到完全一致的 old_string。请先 read_file 核对原文（含缩进与空行），或改用更短的唯一片段。".to_string();
            if !hint.is_empty() {
                message.push('\n');
                message.push_str(&hint);
            }
            return ToolResult::fail(message);
        }
        let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        if count > 1 && !replace_all {
            return ToolResult::fail(format!(
                "old_string 在文件中出现了 {count} 次，请补充上下文使其唯一，或设置 replace_all=true"
            ));
        }
        let updated = if replace_all {
            text.replace(old, new)
        } else {
            text.replacen(old, new, 1)
        };
        if let Err(error) = std::fs::write(&path, updated) {
            return ToolResult::fail(format!("写入失败：{error}"));
        }
        self.remember(&path);
        let delta = new.matches('\n').count() as i64 - old.matches('\n').count() as i64;
        let rel = self.relative(&path);
        ToolResult::ok(format!("已修改 {rel}（行数变化 {delta:+}）"))
    }

    fn write_file(&mut self, args: &Value) -> ToolResult {
        let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
        let path = match self.resolve(raw) {
            Ok(path) => path,
            Err(error) => return ToolResult::fail(format!("参数错误：{error}")),
        };
        let Some(content) = args.get("content").and_then(Value::as_str) else {
            return ToolResult::fail("content 必须是字符串");
        };
        if content.len() > MAX_WRITE_BYTES {
            return ToolResult::fail("内容超过 800KB 上限");
        }
        let existed = path.exists();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(&path, content) {
            return ToolResult::fail(format!("写入失败：{error}"));
        }
        self.remember(&path);
        let rel = self.relative(&path);
        ToolResult::ok(format!(
            "{} {rel}（{} B）",
            if existed { "覆盖写入" } else { "新建" },
            content.len()
        ))
    }

    fn delete_file(&mut self, args: &Value) -> ToolResult {
        let raw = args.get("path").and_then(Value::as_str).unwrap_or("");
        let path = match self.resolve(raw) {
            Ok(path) => path,
            Err(error) => return ToolResult::fail(format!("参数错误：{error}")),
        };
        if !path.exists() {
            return ToolResult::fail("文件不存在");
        }
        if let Err(error) = std::fs::remove_file(&path) {
            return ToolResult::fail(format!("删除失败：{error}"));
        }
        self.remember(&path);
        ToolResult::ok(format!("已删除 {}", self.relative(&path)))
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string())
    }

    fn command_problem(&self, command: &str) -> Option<String> {
        if !self.allow_commands {
            return Some("当前配置禁止执行命令（可在设置中打开「允许运行验证命令」）".to_string());
        }
        for pattern in DENY_PATTERNS {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if regex.is_match(command) {
                    return Some(format!("命令被安全策略拒绝（匹配 /{pattern}/）"));
                }
            }
        }
        let program = command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_start_matches("./")
            .to_string();
        if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
            return Some(format!(
                "命令 {program} 不在白名单内（允许：npm / pytest / go / cargo / tsc / ruff 等）"
            ));
        }
        None
    }

    pub async fn run_shell(&self, command: &str, timeout_secs: u64) -> ToolResult {
        if let Some(problem) = self.command_problem(command) {
            return ToolResult::fail(problem);
        }
        let (shell, flag) = if cfg!(windows) {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        };
        let child = match tokio::process::Command::new(shell)
            .arg(flag)
            .arg(command)
            .current_dir(&self.root)
            .env("CI", "1")
            .env("NO_COLOR", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => return ToolResult::fail(format!("无法启动命令：{error}")),
        };

        let output = match tokio::time::timeout(
            Duration::from_secs(timeout_secs.max(1)),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => return ToolResult::fail(format!("命令执行失败：{error}")),
            Err(_) => {
                return ToolResult::fail(format!("命令超时（{timeout_secs}s）：{command}"));
            }
        };

        let mut text = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        text.push_str(&stderr);
        let output_text = text.trim().to_string();
        let code = output.status.code().unwrap_or(-1);
        let ok = code == 0;
        let body = if output_text.is_empty() {
            "（无输出）".to_string()
        } else {
            output_text
        };
        ToolResult {
            ok,
            content: self.truncate(&format!("$ {command}\n退出码 {code}\n{body}")),
            meta: json!({ "exitCode": code }),
        }
    }

    async fn run_command(&self, args: &Value) -> ToolResult {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if command.is_empty() {
            return ToolResult::fail("缺少 command");
        }
        let timeout = args
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(self.default_timeout)
            .min(600);
        self.run_shell(&command, timeout).await
    }

    async fn run_tests(&self) -> ToolResult {
        let (test, _, _) = repomap::detect_commands(&self.root);
        match test {
            Some(command) => self.run_shell(&command, 300).await,
            None => ToolResult::fail("没有探测到测试命令（可在项目里配置 npm test / pytest / go test）"),
        }
    }

    fn finish(&mut self, args: &Value) -> ToolResult {
        self.finished = true;
        self.summary = args
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if let Some(files) = args.get("changed_files").and_then(Value::as_array) {
            for item in files {
                if let Some(path) = item.as_str() {
                    if !self.changed_files.contains(&path.to_string()) {
                        self.changed_files.push(path.to_string());
                    }
                }
            }
        }
        ToolResult::ok("任务已结束")
    }
}

fn nearest_line_hint(text: &str, needle: &str) -> String {
    let key = needle
        .split('\n')
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if key.is_empty() {
        return String::new();
    }
    let key: String = key.chars().take(60).collect();
    for (number, line) in text.lines().enumerate() {
        if line.contains(&key) {
            let snippet: String = line.trim().chars().take(120).collect();
            return format!("第 {} 行包含相近内容：{snippet}", number + 1);
        }
    }
    String::new()
}

/// 极简 glob：支持 **、*、?（够工具用，避免引入额外依赖）
pub fn glob_match(pattern: &str, path: &str) -> bool {
    fn helper(pattern: &[char], path: &[char]) -> bool {
        if pattern.is_empty() {
            return path.is_empty();
        }
        match pattern[0] {
            '*' => {
                // ** 跨目录，* 不跨
                let doublestar = pattern.get(1) == Some(&'*');
                let rest = if doublestar { &pattern[2..] } else { &pattern[1..] };
                if doublestar {
                    let rest = rest.strip_prefix(&['/']).unwrap_or(rest);
                    for index in 0..=path.len() {
                        if helper(rest, &path[index..]) {
                            return true;
                        }
                    }
                    return false;
                }
                for index in 0..=path.len() {
                    if index > 0 && path[index - 1] == '/' {
                        break;
                    }
                    if helper(rest, &path[index..]) {
                        return true;
                    }
                }
                false
            }
            '?' => !path.is_empty() && path[0] != '/' && helper(&pattern[1..], &path[1..]),
            other => !path.is_empty() && path[0] == other && helper(&pattern[1..], &path[1..]),
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let path: Vec<char> = path.chars().collect();
    helper(&pattern, &path)
}
