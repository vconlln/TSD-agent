//! 对话 Agent（L3）：流式 + 只读工具 + 改动提案。
//!
//! 与流水线 Agent 的区别（对应 docs/AGENT-DESIGN.md 第 12 节）：
//!   对话里没有写盘权限，改动一律走 propose_edit 变成提案，由用户点「应用到代码」才落盘。

use std::{path::Path, sync::atomic::Ordering};

use serde_json::{json, Value};

use crate::{
    diff, events, llm::{Chunk, Llm, ToolCall},
    runs, state::AppState, store,
};

const MAX_ROUNDS: usize = 6;
const MAX_EDITS: usize = 8;
const OBSERVATION_LIMIT: usize = 4000;

const SYSTEM_CHAT: &str = "你是 TSD Agent 的项目升级助手，正在和工程师对话。你熟悉这个项目的原始方案、升级方案与升级后的代码库。\n\n工作方式：\n1. 涉及具体实现时，先用 list_files / read_file / grep 核实，不要凭印象作答；\n2. 要改代码时用 propose_edit 提交完整文件内容，用户会在界面上审阅后决定是否应用；\n3. 回答用简体中文，结构清晰但不啰嗦；代码与路径保持原样；\n4. 不要编造文件内容或测试结果；\n5. 不需要改代码时直接回答，不要调用 propose_edit。";

pub fn tool_specs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "列出项目中的文件（按目录），用来了解结构。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "相对项目根的目录，默认根目录" },
                        "depth": { "type": "integer", "description": "递归深度，1-4，默认 2" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取文件内容（带行号）。修改前必须先读。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "相对路径" },
                        "offset": { "type": "integer", "description": "起始行，默认 1" },
                        "limit": { "type": "integer", "description": "最多行数，默认 400" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "按关键字搜索代码，返回 文件:行号:内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "要搜索的文本" }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "propose_edit",
                "description": "提交一个文件的完整最终内容作为修改建议（用户审阅后才落盘）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "相对路径，新文件也可以" },
                        "content": { "type": "string", "description": "完整文件内容，不要省略" },
                        "reason": { "type": "string", "description": "为什么这样改" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "update_plan",
                "description": "更新任务清单（可选，多步任务时用）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": { "type": "string" },
                                    "status": { "type": "string" }
                                }
                            }
                        }
                    },
                    "required": ["steps"]
                }
            }
        }
    ])
}

fn make_edit(target_dir: &Path, rel: &str, content: &str, reason: &str) -> Option<Value> {
    let rel = rel.trim().trim_start_matches("./");
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        return None;
    }
    let path = target_dir.join(rel);
    let before = if path.exists() {
        store::read_text(&path, 600_000).0
    } else {
        String::new()
    };
    let (patch, additions, deletions, _) = diff::patch_for(&before, content, rel);
    Some(json!({
        "path": rel,
        "before": before,
        "after": content,
        "patch": patch,
        "additions": additions,
        "deletions": deletions,
        "reason": reason,
    }))
}

fn run_tool(target_dir: &Path, call: &ToolCall, edits: &mut Vec<Value>) -> (bool, String, String) {
    let args = call.arguments.clone();
    match call.name.as_str() {
        "propose_edit" => {
            let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            let reason = args.get("reason").and_then(Value::as_str).unwrap_or("");
            if rel.is_empty() || content.is_empty() {
                return (false, "propose_edit 需要 path 与 content".to_string(), rel.to_string());
            }
            if edits.len() >= MAX_EDITS {
                return (false, format!("一次最多提 {} 个文件", MAX_EDITS), rel.to_string());
            }
            match make_edit(target_dir, rel, content, reason) {
                Some(edit) => {
                    let summary = format!(
                        "已记录改动建议：{}（+{} / -{}）",
                        rel,
                        edit["additions"].as_u64().unwrap_or(0),
                        edit["deletions"].as_u64().unwrap_or(0)
                    );
                    edits.push(edit);
                    (true, summary, rel.to_string())
                }
                None => (false, format!("路径不可写：{}", rel), rel.to_string()),
            }
        }
        "list_files" => {
            let depth = args.get("depth").and_then(Value::as_u64).unwrap_or(2).clamp(1, 4) as usize;
            let files = store::walk_files(target_dir);
            let mut lines: Vec<String> = Vec::new();
            for rel in files.keys() {
                if rel.matches('/').count() + 1 > depth {
                    continue;
                }
                lines.push(rel.clone());
                if lines.len() >= 200 {
                    break;
                }
            }
            if lines.is_empty() {
                lines.push("（目录为空）".to_string());
            }
            (true, lines.join("\n"), format!("{} 个文件", files.len()))
        }
        "read_file" => {
            let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(400).clamp(1, 2000) as usize;
            let Some(abs) = crate::state::safe_join(target_dir, rel) else {
                return (false, format!("路径越界：{}", rel), rel.to_string());
            };
            if !abs.is_file() {
                return (false, format!("文件不存在：{}", rel), rel.to_string());
            }
            let (text, truncated) = store::read_text(&abs, 400_000);
            let numbered: Vec<String> = text
                .lines()
                .enumerate()
                .skip(offset.saturating_sub(1))
                .take(limit)
                .map(|(index, line)| format!("{:>5} | {}", index + 1, line))
                .collect();
            let mut body = numbered.join("\n");
            if truncated {
                body.push_str("\n（文件较大，已截断）");
            }
            (true, body, rel.to_string())
        }
        "grep" => {
            let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
            if pattern.is_empty() {
                return (false, "grep 需要 pattern".to_string(), String::new());
            }
            let needle = pattern.to_lowercase();
            let mut hits: Vec<String> = Vec::new();
            for rel in store::walk_files(target_dir).keys() {
                let abs = target_dir.join(rel);
                if store::is_binary(&abs) {
                    continue;
                }
                let (text, _) = store::read_text(&abs, 200_000);
                for (index, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&needle) {
                        hits.push(format!("{}:{}:{}", rel, index + 1, line.trim()));
                        if hits.len() >= 60 {
                            break;
                        }
                    }
                }
                if hits.len() >= 60 {
                    break;
                }
            }
            if hits.is_empty() {
                return (true, format!("没有匹配：{}", pattern), pattern.to_string());
            }
            (true, hits.join("\n"), format!("{} 处匹配", hits.len()))
        }
        "update_plan" => {
            let steps = args.get("steps").cloned().unwrap_or_else(|| json!([]));
            (true, format!("已更新任务清单"), format!("{} 项", steps.as_array().map(|a| a.len()).unwrap_or(0)))
        }
        other => (false, format!("未知工具：{}", other), other.to_string()),
    }
}

pub struct ChatTask {
    pub state: Arc<AppState>,
    pub channel: Arc<events::RunChannel>,
    pub run: runs::Run,
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

use std::sync::Arc;

impl ChatTask {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn save_run(&self) {
        let _ = runs::save_run(&self.state.project_dir(&self.run.project_id), &self.run);
    }

    fn step(&mut self, key: &str, status: &str, detail: Option<String>) {
        self.run.set_step(key, status, detail.clone(), None, None);
        self.save_run();
        let mut data = json!({ "key": key, "status": status });
        if let Some(detail) = detail.clone() {
            data["detail"] = json!(detail);
        }
        self.channel.emit_full("step.status", Some(key.to_string()), None, detail, None, Some(data));
    }

    pub async fn run_chat(mut self, project: Value, message: String, history: Vec<Value>) -> Value {
        let project_id = self.run.project_id.clone();
        let target_dir = self.state.target_dir(&project);
        let config = crate::llm::LlmConfig::from_workspace(&self.state.workspace);
        let online = config.available();
        self.channel.log(
            "info",
            if online { "对话模型已连接" } else { "未配置模型，使用离线回复" },
            None,
        );

        self.step("context", "running", Some("读取项目上下文".to_string()));
        let files = store::walk_files(&target_dir);
        let (update_doc, _) = store::read_text(&self.state.update_path(&project_id), 200_000);
        let (plan_doc, _) = store::read_text(&self.state.plan_path(&project_id), 200_000);
        self.step("context", "done", Some(format!("索引 {} 个文件", files.len())));

        self.step("reason", "running", Some("理解修改需求".to_string()));
        let mut edits: Vec<Value> = Vec::new();
        let mut outcome_reply = String::new();
        let mut outcome_reasoning = String::new();
        let mut tool_calls = 0usize;
        let mut rounds = 0usize;

        if online && !self.stopped() {
            let context = format!(
                "## 项目背景\n- 项目：{}\n\n### 升级方案（节选）\n{}\n\n### 原始方案（节选）\n{}\n\n### 代码库文件（前 200 个）\n{}",
                project.get("name").and_then(Value::as_str).unwrap_or("项目"),
                &update_doc[..update_doc.len().min(3000)],
                &plan_doc[..plan_doc.len().min(1200)],
                files.keys().take(200).cloned().collect::<Vec<_>>().join("\n")
            );
            let mut messages: Vec<Value> = vec![
                json!({ "role": "system", "content": SYSTEM_CHAT }),
                json!({ "role": "user", "content": context }),
                json!({ "role": "assistant", "content": "收到，我已了解项目当前状态。" }),
            ];
            for item in &history {
                if let (Some(role), Some(content)) = (
                    item.get("role").and_then(Value::as_str),
                    item.get("content").and_then(Value::as_str),
                ) {
                    if (role == "user" || role == "assistant") && !content.trim().is_empty() {
                        messages.push(json!({ "role": role, "content": content }));
                    }
                }
            }
            messages.push(json!({ "role": "user", "content": message.clone() }));

            let llm = Llm::new(config);
            let specs = tool_specs();
            let mut use_tools = true;
            let mut use_stream = true;

            for round in 0..MAX_ROUNDS {
                if self.stopped() {
                    break;
                }
                rounds = round + 1;
                let tools = if use_tools { Some(specs.clone()) } else { None };
                let channel = self.channel.clone();

                let result = if use_stream {
                    let on_chunk = {
                        let channel = channel.clone();
                        move |chunk: Chunk| match chunk {
                            Chunk::Reasoning(text) => {
                                channel.emit_full(
                                    "chat.reasoning",
                                    None,
                                    None,
                                    None,
                                    Some(text.clone()),
                                    Some(json!({ "delta": text })),
                                );
                            }
                            Chunk::Content(text) => {
                                channel.emit_full(
                                    "chat.delta",
                                    None,
                                    None,
                                    None,
                                    Some(text.clone()),
                                    Some(json!({ "delta": text })),
                                );
                            }
                            Chunk::ToolCalls(calls) => {
                                // 工具调用由本轮 outcome 统一处理，这里只记个调试量
                                channel.log(
                                    "debug",
                                    &format!("模型请求 {} 个工具", calls.len()),
                                    None,
                                );
                            }
                            Chunk::Done => {}
                        }
                    };
                    match llm.stream_chat(&messages, tools.as_ref(), on_chunk).await {
                        Ok(outcome) => Ok(outcome),
                        Err(error) => {
                            if error == "stream-unsupported" {
                                self.channel.log("warn", "模型不支持流式，退回非流式对话", None);
                                use_stream = false;
                                llm.chat_once(&messages, tools.as_ref()).await
                            } else if error.starts_with("tools-unsupported") && use_tools {
                                self.channel.log("warn", "模型不接受 tools，改用纯文本对话", None);
                                use_tools = false;
                                use_stream = false;
                                llm.chat_once(&messages, None).await
                            } else {
                                Err(error)
                            }
                        }
                    }
                } else {
                    llm.chat_once(&messages, tools.as_ref()).await
                };

                let outcome = match result {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        self.channel.log("error", &format!("模型调用失败：{error}"), None);
                        break;
                    }
                };

                if !use_stream {
                    // 非流式路径也要给前端增量感：按 36 字切片推
                    if !outcome.reasoning.is_empty() {
                        let text = outcome.reasoning.clone();
                        self.channel.emit_full(
                            "chat.reasoning",
                            None,
                            None,
                            None,
                            Some(text.clone()),
                            Some(json!({ "delta": text })),
                        );
                    }
                    for piece in split_chunks(&outcome.content, 36) {
                        self.channel.emit_full(
                            "chat.delta",
                            None,
                            None,
                            None,
                            Some(piece.clone()),
                            Some(json!({ "delta": piece })),
                        );
                    }
                }

                outcome_reply.push_str(&outcome.content);
                outcome_reasoning.push_str(&outcome.reasoning);

                if outcome.tool_calls.is_empty() {
                    break;
                }

                tool_calls += outcome.tool_calls.len();
                let assistant_calls: Vec<Value> = outcome
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string())
                            }
                        })
                    })
                    .collect();
                messages.push(json!({
                    "role": "assistant",
                    "content": outcome.content,
                    "tool_calls": assistant_calls,
                }));

                for call in &outcome.tool_calls {
                    let started = std::time::Instant::now();
                    let (ok, observation, preview) = run_tool(&target_dir, call, &mut edits);
                    let duration = started.elapsed().as_millis() as u64;
                    self.channel.emit_full(
                        "chat.tool",
                        None,
                        None,
                        Some(format!("{} {}", call.name, if ok { "✓" } else { "✗" })),
                        None,
                        Some(json!({
                            "id": call.id,
                            "tool": call.name,
                            "args": call.arguments,
                            "ok": ok,
                            "durationMs": duration,
                            "preview": preview,
                            "observation": observation.chars().take(OBSERVATION_LIMIT).collect::<String>(),
                        })),
                    );
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": observation.chars().take(OBSERVATION_LIMIT).collect::<String>(),
                    }));
                }
            }
        }

        let reply = if outcome_reply.trim().is_empty() {
            offline_reply(&project, &message, &files, &target_dir, &mut edits)
        } else {
            outcome_reply
        };

        let reasoning_chars = outcome_reasoning.chars().count();
        if reasoning_chars > 0 {
            self.channel
                .log("debug", &format!("思考 {} 字", reasoning_chars), None);
        }

        self.step("reason", "done", Some("已生成回复".to_string()));
        self.step("patch", "running", Some("构造可应用补丁".to_string()));

        let proposal = if edits.is_empty() {
            None
        } else {
            let id = crate::runs::random_id();
            let proposal = json!({
                "id": id,
                "summary": if edits.len() > 1 { format!("{} 个文件的改动建议", edits.len()) } else { "对话修改建议".to_string() },
                "rationale": "由对话 Agent 生成的改动，审阅后可一键应用",
                "edits": edits.clone(),
                "createdAt": events::now_ms(),
                "applied": false,
            });
            // 落盘 proposals.json，供 /apply 使用
            let path = self.state.project_dir(&project_id).join("proposals.json");
            let mut all = store::read_json(&path).unwrap_or_else(|| json!({}));
            if let Some(object) = all.as_object_mut() {
                object.insert(id.to_string(), proposal.clone());
            }
            let _ = std::fs::write(&path, serde_json::to_string(&all).unwrap_or_else(|_| "{}".to_string()));
            Some(proposal)
        };

        self.step("patch", "done", Some(if edits.is_empty() { "无需改动".to_string() } else { format!("{} 个文件", edits.len()) }));

        self.channel.emit(
            "chat.message",
            Some(json!({
                "content": reply,
                "proposal": proposal,
                "summary": if edits.is_empty() { "对话回答" } else { "对话修改建议" },
            })),
        );

        self.run.status = "done".to_string();
        self.run.finished_at = Some(events::now_ms());
        self.run.summary = Some(if edits.is_empty() {
            "对话回答".to_string()
        } else {
            format!("{} 条改动建议", edits.len())
        });
        self.save_run();
        self.channel.emit(
            "run.done",
            Some(json!({ "summary": self.run.summary, "status": "done" })),
        );
        json!({
            "status": "done",
            "toolCalls": tool_calls,
            "rounds": rounds,
            "edits": edits.len(),
        })
    }
}

fn split_chunks(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.chunks(size.max(1)).map(|chunk| chunk.iter().collect()).collect()
}

fn offline_reply(
    project: &Value,
    message: &str,
    files: &std::collections::BTreeMap<String, u64>,
    target_dir: &Path,
    edits: &mut Vec<Value>,
) -> String {
    let name = project.get("name").and_then(Value::as_str).unwrap_or("项目");
    let mut lines = vec![
        "当前为离线模式，未配置模型，因此只能给出分析建议。".to_string(),
        String::new(),
        format!("- 项目：{}", name),
        format!("- 已索引文件：{} 个", files.len()),
    ];
    let notes = "UPGRADE_NOTES.md";
    let path = target_dir.join(notes);
    let before = if path.exists() {
        store::read_text(&path, 400_000).0
    } else {
        String::new()
    };
    let addition = format!("\n## 追加需求（{}）\n\n{}\n", events::now_ms(), message.trim());
    let after = if before.trim().is_empty() {
        format!("# 升级说明\n{}", addition)
    } else {
        format!("{}{}", before.trim_end(), addition)
    };
    if after != before {
        let (patch, additions, deletions, _) = diff::patch_for(&before, &after, notes);
        edits.push(json!({
            "path": notes,
            "before": before,
            "after": after,
            "patch": patch,
            "additions": additions,
            "deletions": deletions,
            "reason": "离线模式：记录追加需求",
        }));
        lines.push(String::new());
        lines.push(format!("已把你这条需求追加到 {}（可在下方一键应用）。", notes));
    }
    lines.join("\n")
}
