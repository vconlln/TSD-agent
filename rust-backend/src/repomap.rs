//! 给 Agent 的「地图」：仓库结构、符号索引、项目约定与验证命令。
//!
//! 模型看不到磁盘，这些确定性信息决定它第一步有没有方向。
//! 把仓库压成几千字符的符号表，比把整仓代码塞进上下文有效得多。

use std::path::Path;

use serde_json::Value;

use crate::store;

const ENTRY_HINTS: &[&str] = &[
    "main.", "app.", "index.", "server.", "cli.", "boot.", "package.json", "pyproject.toml",
    "go.mod", "cargo.toml", "pom.xml", "build.gradle",
];

const INSTRUCTION_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".cursor/rules",
    ".github/copilot-instructions.md",
    "CONTRIBUTING.md",
];

fn is_source(ext: &str) -> bool {
    matches!(
        ext,
        "py" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "go" | "rs" | "java" | "kt" | "cs"
            | "rb" | "php" | "swift" | "c" | "h" | "cpp" | "hpp" | "vue" | "svelte" | "scala"
            | "dart"
    )
}

fn ext_of(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

fn patterns_for(path: &str) -> Vec<&'static str> {
    let ext = ext_of(path);
    match ext.as_str() {
        "py" => vec![
            r"(?m)^(?:async\s+)?def\s+([A-Za-z_]\w*)",
            r"(?m)^class\s+([A-Za-z_]\w*)",
        ],
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "vue" | "svelte" => vec![
            r"(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
            r"(?m)^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)",
            r"(?m)^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)",
            r"(?m)^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=",
        ],
        "go" => vec![
            r"(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)",
            r"(?m)^type\s+([A-Za-z_]\w*)",
        ],
        "rs" => vec![
            r"(?m)^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)",
            r"(?m)^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)",
        ],
        "java" | "kt" | "cs" | "scala" => vec![
            r"(?m)^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)",
            r"(?m)^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\], ]+\s+([A-Za-z_]\w*)\s*\(",
        ],
        _ => Vec::new(),
    }
}

pub fn extract_symbols(path: &str, text: &str, limit: usize) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for pattern in patterns_for(path) {
        let Ok(regex) = regex::Regex::new(pattern) else { continue };
        for captured in regex.captures_iter(text) {
            let name = captured.get(1).map(|item| item.as_str().to_string()).unwrap_or_default();
            if !name.is_empty() && !found.contains(&name) {
                found.push(name);
            }
            if found.len() >= limit {
                return found;
            }
        }
    }
    found
}

pub fn build_repo_map(root: &Path, max_chars: usize, max_files: usize) -> String {
    if !root.exists() {
        return "（代码目录不存在）".to_string();
    }
    let files = store::walk_files(root);
    let total = files.len();
    let mut entries: Vec<(i32, String, String)> = Vec::new();
    for (rel, size) in &files {
        let ext = ext_of(rel);
        let lower = rel.to_lowercase();
        let mut priority = 0i32;
        if ENTRY_HINTS
            .iter()
            .any(|hint| lower.ends_with(hint) || lower == *hint)
        {
            priority -= 2;
        }
        if lower.contains("test") || lower.contains("spec") {
            priority += 1;
        }
        if !is_source(&ext) {
            priority += 2;
        }
        if *size > 400_000 {
            priority += 1;
        }
        entries.push((priority, rel.clone(), ext));
    }
    entries.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));

    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut shown = 0usize;
    for (_, rel, ext) in entries.iter().take(max_files) {
        let detail = if is_source(ext) {
            let (text, _) = store::read_text(&root.join(rel), 200_000);
            let mut detail = String::new();
            if !text.is_empty() {
                let symbols = extract_symbols(rel, &text, 10);
                let line_count = text.lines().count().max(1);
                let language = {
                    let value = store::language_of(rel);
                    if value.is_empty() { ext.clone() } else { value }
                };
                detail = format!(" ({language}, {line_count} 行)");
                if !symbols.is_empty() {
                    detail.push_str(": ");
                    detail.push_str(&symbols.join(", "));
                }
            }
            detail
        } else {
            let language = store::language_of(rel);
            let label = if language.is_empty() {
                if ext.is_empty() { "文件".to_string() } else { format!("{ext} 文件") }
            } else {
                language
            };
            format!(" ({label})")
        };
        let line = format!("- {rel}{detail}");
        if used + line.chars().count() > max_chars {
            lines.push(format!("- …其余 {} 个文件未展开", total.saturating_sub(shown)));
            break;
        }
        used += line.chars().count() + 1;
        shown += 1;
        lines.push(line);
    }
    format!("仓库共 {total} 个文件，以下按重要性排列：\n{}", lines.join("\n"))
}

pub fn read_project_instructions(root: &Path, max_chars: usize) -> String {
    for name in INSTRUCTION_FILES {
        let candidate = root.join(name);
        if candidate.is_file() {
            let (text, _) = store::read_text(&candidate, 200_000);
            let text = text.trim();
            if !text.is_empty() {
                let clipped: String = text.chars().take(max_chars).collect();
                return format!("来源：{name}\n\n{clipped}");
            }
        }
    }
    String::new()
}

/// 探测项目的测试 / 类型检查 / 静态检查命令
pub fn detect_commands(root: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let mut test: Option<String> = None;
    let mut typecheck: Option<String> = None;
    let mut lint: Option<String> = None;

    if let Some(data) = store::read_json(&root.join("package.json")) {
        if let Some(scripts) = data.get("scripts").and_then(Value::as_object) {
            for (key, target) in [
                ("test", 0),
                ("typecheck", 1),
                ("type-check", 1),
                ("lint", 2),
            ] {
                if scripts.get(key).map(Value::is_string).unwrap_or(false) {
                    let command = Some(format!("npm run {key}"));
                    match target {
                        0 => test = command,
                        1 => typecheck = command,
                        _ => lint = command,
                    }
                }
            }
        }
    }

    let pyproject = root.join("pyproject.toml");
    let pyproject_text = if pyproject.exists() {
        store::read_text(&pyproject, 400_000).0
    } else {
        String::new()
    };
    let has_pytest = pyproject_text.contains("pytest")
        || root.join("tests").is_dir()
        || std::fs::read_dir(root)
            .map(|iter| {
                iter.filter_map(|item| item.ok())
                    .any(|item| {
                        let name = item.file_name().to_string_lossy().to_string();
                        (name.starts_with("test_") && name.ends_with(".py"))
                            || name.ends_with("_test.py")
                    })
            })
            .unwrap_or(false);
    if has_pytest && test.is_none() {
        let interpreter = if cfg!(windows) { "python" } else { "python3" };
        test = Some(format!("{interpreter} -m pytest -q"));
    }
    if (root.join("mypy.ini").exists() || root.join("pyrightconfig.json").exists()) && typecheck.is_none() {
        typecheck = Some("python -m mypy .".to_string());
    }
    if pyproject_text.contains("[tool.ruff") && lint.is_none() {
        lint = Some("python -m ruff check .".to_string());
    }
    if root.join("go.mod").exists() {
        test = test.or_else(|| Some("go test ./...".to_string()));
        lint = lint.or_else(|| Some("go vet ./...".to_string()));
    }
    if root.join("Cargo.toml").exists() {
        test = test.or_else(|| Some("cargo test --quiet".to_string()));
        typecheck = typecheck.or_else(|| Some("cargo check --quiet".to_string()));
    }
    if root.join("pom.xml").exists() {
        test = test.or_else(|| Some("mvn -q -DskipTests=false test".to_string()));
    }
    (test, typecheck, lint)
}
