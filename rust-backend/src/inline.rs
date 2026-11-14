//! 编辑器内 AI：解释选中代码、按指令改写选区（Cursor 式交互的服务端部分）。
//!
//! 与 Python 参照实现的差别只在提示词存放位置（L5 会挪到外部 markdown 热重载）；
//! 行为一致：
//!   - 让模型只返回「选区替换文本」，降低整文件重写的风险；
//!   - 用统一补丁返回给前端做接受 / 拒绝；
//!   - 未配置模型时解释退化为结构化静态分析，修改给出明确提示。

use serde_json::{json, Value};

use crate::{
    diff,
    llm::{Llm, LlmConfig},
    state::AppState,
    store,
};

const MAX_FILE_CHARS: usize = 200_000;
const MAX_SELECTION_LINES: usize = 400;
/// 三个反引号：写成转义，避免源码里出现围栏字样
const FENCE: &str = "\u{60}\u{60}\u{60}";

pub struct InlineError {
    pub status: u16,
    pub message: String,
}

impl InlineError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn strip_fence(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with(FENCE) {
        return text.to_string();
    }
    let mut lines: Vec<&str> = trimmed.lines().collect();
    if lines.is_empty() {
        return text.to_string();
    }
    lines.remove(0);
    if lines
        .last()
        .map(|line| line.trim().starts_with(FENCE))
        .unwrap_or(false)
    {
        lines.pop();
    }
    lines.join("\n")
}

/// 解析项目目标目录里的文件（路径沙箱 + 二进制 + 大小保护）
fn resolve(state: &AppState, project: &Value, path: &str) -> Result<(String, String), InlineError> {
    let target = state.target_dir(project);
    if !target.exists() {
        return Err(InlineError::new(409, "升级结果目录不存在，请先执行升级"));
    }
    if path.trim().is_empty() {
        return Err(InlineError::new(400, "缺少文件路径"));
    }
    let Some(file_path) = crate::state::safe_join(&target, path) else {
        return Err(InlineError::new(400, "非法文件路径"));
    };
    if !file_path.is_file() {
        return Err(InlineError::new(404, "文件不存在"));
    }
    if store::is_binary(&file_path) {
        return Err(InlineError::new(400, "二进制文件不支持 AI 编辑"));
    }
    let (content, truncated) = store::read_text(&file_path, MAX_FILE_CHARS);
    if truncated {
        return Err(InlineError::new(413, "文件过大，暂不支持 AI 编辑"));
    }
    Ok((path.to_string(), content))
}

/// 返回 (起始字节偏移, 结束字节偏移, 行数)
fn selection_bounds(
    content: &str,
    start_line: u64,
    end_line: u64,
) -> Result<(usize, usize, usize), InlineError> {
    let lines: Vec<&str> = content.split('\n').collect();
    let total = lines.len() as u64;
    let start = (start_line.max(1)).min(total) as usize;
    let end = end_line.max(start as u64).min(total) as usize;
    if end + 1 - start > MAX_SELECTION_LINES {
        return Err(InlineError::new(
            413,
            format!("选中行数过多（上限 {MAX_SELECTION_LINES} 行）"),
        ));
    }
    let start_offset: usize = lines.iter().take(start - 1).map(|line| line.len() + 1).sum();
    let end_offset: usize = lines
        .iter()
        .take(end)
        .map(|line| line.len() + 1)
        .sum::<usize>()
        .saturating_sub(1);
    Ok((start_offset, end_offset.max(start_offset), end - start + 1))
}

pub async fn edit(
    state: &AppState,
    project: &Value,
    path: &str,
    instruction: &str,
    start_line: u64,
    end_line: u64,
    content: Option<&str>,
) -> Result<Value, InlineError> {
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err(InlineError::new(400, "请描述要做的修改"));
    }
    let (rel, mut current) = resolve(state, project, path)?;
    if let Some(content) = content {
        current = content.to_string();
    }

    let selection_mode = start_line > 0 && end_line > 0;
    let (start_offset, end_offset, line_count) = if selection_mode {
        selection_bounds(&current, start_line, end_line)?
    } else {
        (0, current.len(), current.split('\n').count())
    };

    let config = LlmConfig::from_workspace(&state.workspace);
    if !config.available() {
        return Ok(json!({
            "ok": false,
            "mode": "offline",
            "error": "未配置可用的推理引擎，暂时无法生成代码修改。请在设置中配置模型，或通过 W3 凭证接入模型服务。",
            "path": rel,
        }));
    }

    let scope_text = if selection_mode {
        format!("替换第 {start_line} 到 {end_line} 行")
    } else {
        "重写整个文件".to_string()
    };
    let selection_block = if selection_mode {
        let slice = current.get(start_offset..end_offset).unwrap_or("");
        format!("\n<selection>\n{slice}\n</selection>\n")
    } else {
        String::new()
    };
    let language = {
        let value = store::language_of(&rel);
        if value.is_empty() { "text".to_string() } else { value }
    };
    let name = project.get("name").and_then(Value::as_str).unwrap_or("项目");
    let version = project.get("targetVersion").and_then(Value::as_str).unwrap_or("next");
    let head: String = current.chars().take(60_000).collect();
    let messages = vec![
        json!({ "role": "system", "content": crate::prompts::get("inline-edit") }),
        json!({
            "role": "user",
            "content": format!(
                "项目：{name}（目标版本 v{version}）\n文件：{rel}（{language}）\n任务：{scope_text}\n{selection_block}\n<file>\n{head}\n</file>\n\n<requirement>\n{instruction}\n</requirement>\n\n只输出 JSON：{{\"summary\":\"一句话说明改了什么\",\"rationale\":\"简短理由\",\"replacement\":\"用于替换选中行的完整代码文本（不含行号与代码围栏）\"}}"
            ),
        }),
    ];

    let llm = Llm::new(config);
    let payload = llm
        .chat_json(&messages, 8000, 0.2)
        .await
        .map_err(|error| InlineError::new(502, format!("模型调用失败：{error}")))?;
    let Some(payload) = payload else {
        return Err(InlineError::new(502, "模型未返回可用的修改内容"));
    };
    let Some(replacement) = payload.get("replacement").and_then(Value::as_str) else {
        return Err(InlineError::new(502, "模型未返回可用的修改内容"));
    };

    let replacement = strip_fence(replacement);
    let after = format!(
        "{}{}{}",
        current.get(..start_offset).unwrap_or(""),
        replacement,
        current.get(end_offset..).unwrap_or("")
    );
    let (patch, additions, deletions, _) = diff::patch_for(&current, &after, &rel);
    Ok(json!({
        "ok": true,
        "mode": "llm",
        "model": llm.config.model,
        "path": rel,
        "scope": if selection_mode { "selection" } else { "file" },
        "startLine": if selection_mode { start_line } else { 1 },
        "endLine": if selection_mode { end_line } else { line_count as u64 },
        "summary": payload.get("summary").and_then(Value::as_str).unwrap_or("代码修改").trim(),
        "rationale": payload.get("rationale").and_then(Value::as_str).unwrap_or("").trim(),
        "replacement": replacement,
        "before": current,
        "after": after,
        "patch": patch,
        "additions": additions,
        "deletions": deletions,
    }))
}

pub async fn explain(
    state: &AppState,
    project: &Value,
    path: &str,
    start_line: u64,
    end_line: u64,
    content: Option<&str>,
    question: Option<&str>,
) -> Result<Value, InlineError> {
    let (rel, mut current) = resolve(state, project, path)?;
    if let Some(content) = content {
        current = content.to_string();
    }

    let selection_mode = start_line > 0 && end_line > 0;
    let (snippet, line_count) = if selection_mode {
        let (start_offset, end_offset, count) = selection_bounds(&current, start_line, end_line)?;
        (
            current.get(start_offset..end_offset).unwrap_or("").to_string(),
            count,
        )
    } else {
        (current.clone(), current.split('\n').count())
    };

    let config = LlmConfig::from_workspace(&state.workspace);
    if !config.available() {
        return Ok(json!({
            "ok": true,
            "mode": "offline",
            "text": heuristic_explanation(&rel, &snippet, selection_mode, line_count),
            "path": rel,
        }));
    }

    let where_text = if selection_mode {
        format!("第 {start_line} 到 {end_line} 行")
    } else {
        "整个文件".to_string()
    };
    let language = {
        let value = store::language_of(&rel);
        if value.is_empty() { "text".to_string() } else { value }
    };
    let body: String = snippet.chars().take(20_000).collect();
    let tail = question
        .map(|text| format!("用户的问题：{text}\n"))
        .unwrap_or_default();
    let messages = vec![
        json!({ "role": "system", "content": crate::prompts::get("inline-explain") }),
        json!({
            "role": "user",
            "content": format!("文件：{rel}（{language}），{where_text}。\n\n<code>\n{body}\n</code>\n\n{tail}"),
        }),
    ];
    let llm = Llm::new(config);
    let outcome = llm
        .chat_once_with(&messages, None, Some(1500), Some(0.2))
        .await
        .map_err(|error| InlineError::new(502, format!("模型调用失败：{error}")))?;
    Ok(json!({
        "ok": true,
        "mode": "llm",
        "model": llm.config.model,
        "text": outcome.content.trim(),
        "path": rel,
    }))
}

fn heuristic_explanation(rel: &str, snippet: &str, selection: bool, line_count: usize) -> String {
    let lines: Vec<&str> = snippet.lines().filter(|line| !line.trim().is_empty()).collect();
    let mut imports: Vec<String> = Vec::new();
    let mut functions: Vec<String> = Vec::new();
    let mut classes: Vec<String> = Vec::new();
    let mut exports: Vec<String> = Vec::new();

    let import_re = regex::Regex::new(r"^\s*(import|from|require\(|#include|using )").unwrap();
    let function_re = regex::Regex::new(r"(?:def|function|func|fn)\s+([A-Za-z_$][\w$]*)").unwrap();
    let class_re = regex::Regex::new(r"(?:class|interface|struct|enum)\s+([A-Za-z_$][\w$]*)").unwrap();
    let export_re = regex::Regex::new(
        r"(?m)^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)",
    )
    .unwrap();

    for line in &lines {
        if import_re.is_match(line) {
            imports.push(line.trim().to_string());
        }
    }
    for captured in function_re.captures_iter(snippet) {
        functions.push(captured[1].to_string());
    }
    for captured in class_re.captures_iter(snippet) {
        classes.push(captured[1].to_string());
    }
    for captured in export_re.captures_iter(snippet) {
        exports.push(captured[1].to_string());
    }

    let wrap = |items: &[String], limit: usize| {
        items
            .iter()
            .take(limit)
            .map(|item| format!("「{item}」"))
            .collect::<Vec<_>>()
            .join("、")
    };

    let mut parts = vec![format!(
        "**概览**：{} 的{}，约 {} 行、{} 行非空。",
        rel,
        if selection { "选段" } else { "整体" },
        line_count,
        lines.len()
    )];
    if !imports.is_empty() {
        parts.push(format!("**依赖**：{}", wrap(&imports, 6)));
    }
    if !classes.is_empty() {
        parts.push(format!("**类型/类**：{}", wrap(&classes, 6)));
    }
    if !functions.is_empty() {
        parts.push(format!("**函数**：{}", wrap(&functions, 8)));
    }
    if !exports.is_empty() {
        parts.push(format!("**导出**：{}", wrap(&exports, 8)));
    }
    parts.push(
        "> 当前为离线分析（未配置模型），只做结构与符号层面的说明；\
配置推理引擎后可获得逐行语义解释与修改建议。"
            .to_string(),
    );
    parts.join("\n\n")
}
