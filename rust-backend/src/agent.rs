//! Agent 循环：让模型像工程师一样「读代码 → 改代码 → 跑验证 → 修问题」。
//!
//! 与一次性生成的差别：
//!   - 模型每一步只能看到自己主动取回的上下文（工具读文件/搜索），不会被整仓代码淹没；
//!   - 每次修改都能立刻回读确认，改错了下一轮还能看到错误并纠正；
//!   - 改完必须跑测试/类型检查，失败会把输出回喂，最多重试若干轮；
//!   - 全程有步数、时长与上下文预算，随时可取消，每一步都通过事件流可见。
//!
//! 协议两种：tools（OpenAI function calling，首选）/ json（不支持 tools 时的降级）。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use serde_json::{json, Value};

use crate::{
    events::RunChannel,
    llm::Llm,
    prompts,
    repomap,
    toolbox::{tool_specs, Toolbox},
};

const MAX_PARSE_FAILURES: usize = 3;
const MAX_VERIFY_ROUNDS: usize = 2;
const CONTEXT_CHAR_BUDGET: usize = 120_000;

const JSON_PROTOCOL: &str = "\n\n可用工具：{tools}\n\n\
你必须**只输出一个 JSON 对象**，不要输出解释文字或代码围栏，格式二选一：\n\
1) 调用工具：{{\"thought\": \"你的判断\", \"tool\": \"工具名\", \"args\": {{...}}}}\n\
2) 结束任务：{{\"thought\": \"…\", \"final\": \"改动总结与验证结论\", \"changed_files\": [\"…\"]}}\n\
每次只调用一个工具；观察结果会以 user 消息返回给你。";

pub struct AgentConfig {
    pub mode: String,
    pub max_steps: usize,
    pub allow_commands: bool,
    pub verify: bool,
    pub deadline_seconds: u64,
    pub max_observation_chars: usize,
}

impl AgentConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let data = settings.get("agent").cloned().unwrap_or_else(|| json!({}));
        let number = |key: &str, fallback: u64| data.get(key).and_then(Value::as_u64).unwrap_or(fallback);
        let flag = |key: &str, fallback: bool| data.get(key).and_then(Value::as_bool).unwrap_or(fallback);
        Self {
            mode: data
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_string(),
            max_steps: number("maxSteps", 24).clamp(2, 80) as usize,
            allow_commands: flag("allowCommands", true),
            verify: flag("verify", true),
            deadline_seconds: number("deadlineSeconds", 900).clamp(60, 7200),
            max_observation_chars: number("maxObservationChars", 6000).clamp(1000, 20000) as usize,
        }
    }
}

#[derive(Default)]
pub struct AgentStats {
    pub steps: usize,
    pub tool_calls: usize,
    pub failed_calls: usize,
    pub changed_files: Vec<String>,
    pub verified: Option<bool>,
    pub verify_rounds: usize,
    pub protocol: String,
}

pub struct CodeAgent<'a> {
    llm: &'a Llm,
    channel: Arc<RunChannel>,
    config: AgentConfig,
    cancel: Arc<AtomicBool>,
    deadline: Option<Instant>,
    protocol: String,
    stats: AgentStats,
}

struct Decision {
    thought: String,
    calls: Vec<Value>,
    final_summary: Option<String>,
    content: String,
}

impl<'a> CodeAgent<'a> {
    pub fn new(
        llm: &'a Llm,
        channel: Arc<RunChannel>,
        config: AgentConfig,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        let protocol = if config.mode == "auto" || config.mode == "tools" {
            "tools"
        } else {
            "json"
        };
        Self {
            llm,
            channel,
            config,
            cancel,
            deadline: None,
            protocol: protocol.to_string(),
            stats: AgentStats::default(),
        }
    }

    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
            || self
                .deadline
                .map(|deadline| Instant::now() > deadline)
                .unwrap_or(false)
    }

    fn emit(&self, kind: &str, data: Value) {
        self.channel.emit(kind, Some(data));
    }

    fn log(&self, message: &str, level: &str) {
        self.channel.log(level, message, Some("code"));
    }

    fn protocol_suffix(&self) -> String {
        if self.protocol == "tools" {
            return String::new();
        }
        let names: Vec<String> = tool_specs()
            .as_array()
            .map(|specs| {
                specs
                    .iter()
                    .filter_map(|spec| {
                        spec.get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .map(|name| name.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        JSON_PROTOCOL.replace("{tools}", &names.join(", "))
    }

    fn task_brief(task: &str, repo_map: &str, instructions: &str, plan: &str) -> String {
        let mut parts: Vec<String> = vec!["## 升级任务".to_string(), task.trim().to_string()];
        if !plan.trim().is_empty() {
            let clipped: String = plan.trim().chars().take(6000).collect();
            parts.push(String::new());
            parts.push("## 升级方案（需落地实现）".to_string());
            parts.push(clipped);
        }
        if !instructions.trim().is_empty() {
            let clipped: String = instructions.trim().chars().take(3000).collect();
            parts.push(String::new());
            parts.push("## 项目约定（必须遵守）".to_string());
            parts.push(clipped);
        }
        let map: String = repo_map.chars().take(9000).collect();
        parts.push(String::new());
        parts.push("## 仓库地图（符号索引，帮助你定位文件）".to_string());
        parts.push(map);
        parts.push(String::new());
        parts.push("## 工作方式".to_string());
        parts.push("先用 read_file/grep 确认现状，再用 edit_file 做最小改动，最后跑测试验证。".to_string());
        parts.push("不要一次性重写多个文件；每轮只推进一个明确的小目标。".to_string());
        parts.join("\n")
    }

    /// 在给定目录里执行一次编码任务
    pub async fn run(&mut self, task: &str, target_dir: &std::path::Path, plan: &str) -> Value {
        let mut toolbox = Toolbox::new(target_dir, self.config.allow_commands, self.config.max_observation_chars);
        let repo_map = repomap::build_repo_map(target_dir, 9000, 400);
        let instructions = repomap::read_project_instructions(target_dir, 4000);
        self.deadline = Some(Instant::now() + std::time::Duration::from_secs(self.config.deadline_seconds));
        self.stats.protocol = self.protocol.clone();

        let mut messages: Vec<Value> = vec![
            json!({ "role": "system", "content": format!("{}{}", prompts::get("agent"), self.protocol_suffix()) }),
            json!({ "role": "user", "content": Self::task_brief(task, &repo_map, &instructions, plan) }),
        ];

        let mut final_summary = String::new();
        let mut parse_failures = 0usize;

        while self.stats.steps < self.config.max_steps {
            if self.stopped() {
                self.log("Agent 达到预算或被取消，提前收尾", "warn");
                break;
            }
            self.stats.steps += 1;
            let progress = (self.stats.steps * 100 / self.config.max_steps).min(95);
            self.channel.emit_full(
                "step.status",
                Some("code".to_string()),
                None,
                Some(format!(
                    "Agent 第 {} 步 · 已调用工具 {} 次",
                    self.stats.steps, self.stats.tool_calls
                )),
                None,
                Some(json!({
                    "key": "code",
                    "status": "running",
                    "detail": format!("Agent 第 {} 步 · 已调用工具 {} 次", self.stats.steps, self.stats.tool_calls),
                    "progress": progress,
                })),
            );

            let decision = match self.decide(&mut messages).await {
                Ok(decision) => decision,
                Err(error) => {
                    self.log(&format!("模型调用失败：{error}"), "error");
                    break;
                }
            };

            let Some(decision) = decision else {
                parse_failures += 1;
                if parse_failures > MAX_PARSE_FAILURES {
                    self.log("模型连续返回无法解析的内容，结束 Agent", "warn");
                    break;
                }
                messages.push(json!({
                    "role": "user",
                    "content": "无法解析你的回复。请只输出一个 JSON 对象（tool/args 或 final）。",
                }));
                continue;
            };

            if let Some(summary) = decision.final_summary.clone() {
                final_summary = summary;
                if !decision.thought.is_empty() {
                    self.emit("agent.thought", json!({ "text": decision.thought }));
                }
                break;
            }

            let thought = decision.thought.trim().to_string();
            if !thought.is_empty() {
                self.emit("agent.thought", json!({ "text": thought }));
                let clipped: String = thought.chars().take(180).collect();
                self.log(&format!("思考：{clipped}"), "debug");
            }

            if decision.calls.is_empty() {
                // 模型只回了文字：视为结束
                final_summary = decision.content.trim().to_string();
                break;
            }

            for call in decision.calls.clone() {
                let result = self.execute(&call, &mut toolbox).await;
                let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                let observation = format!(
                    "工具 {name} 返回：{}",
                    if result.ok { "成功" } else { "失败" }
                );
                let observation = format!("{observation}\n{}", result.content);
                self.append_observation(&mut messages, &call, &observation, &decision);
                if toolbox.finished {
                    final_summary = toolbox.summary.clone();
                    break;
                }
            }
            if toolbox.finished {
                break;
            }
            messages = self.compact(messages);
        }

        // ---------------- 验证阶段 ----------------
        let mut verified: Option<bool> = None;
        if self.config.verify && self.config.allow_commands && !toolbox.changed_files.is_empty() {
            verified = Some(self.verify(&mut toolbox, &mut messages, &final_summary).await);
            self.stats.verified = verified;
        }

        let mut changed: Vec<String> = toolbox.changed_files.clone();
        changed.sort();
        self.stats.changed_files = changed.clone();
        let summary = if final_summary.trim().is_empty() {
            "Agent 未给出总结".to_string()
        } else {
            final_summary
        };
        if changed.is_empty() {
            self.log("Agent 未修改任何文件", "warn");
        }

        json!({
            "ok": true,
            "summary": summary,
            "steps": self.stats.steps,
            "toolCalls": self.stats.tool_calls,
            "failedCalls": self.stats.failed_calls,
            "changedFiles": self.stats.changed_files,
            "verified": verified,
            "verifyRounds": self.stats.verify_rounds,
            "protocol": self.stats.protocol,
        })
    }

    async fn decide(&mut self, messages: &mut Vec<Value>) -> Result<Option<Decision>, String> {
        if self.protocol == "tools" {
            let specs = tool_specs();
            let outcome = self.llm.chat_once(messages, Some(&specs)).await;
            let outcome = match outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    if error.starts_with("tools-unsupported") {
                        self.protocol = "json".to_string();
                        self.stats.protocol = "json".to_string();
                        self.log("模型不支持 tools 协议，自动切换为 JSON 协议", "warn");
                        messages[0] = json!({
                            "role": "system",
                            "content": format!("{}{}", prompts::get("agent"), self.protocol_suffix()),
                        });
                        return self.decide_json(messages).await;
                    }
                    return Err(error);
                }
            };
            let mut calls: Vec<Value> = Vec::new();
            for call in &outcome.tool_calls {
                calls.push(json!({
                    "id": call.id,
                    "name": call.name,
                    "arguments": call.arguments,
                }));
            }
            let thought = if !outcome.content.trim().is_empty() {
                outcome.content.clone()
            } else {
                outcome.reasoning.clone()
            };
            return Ok(Some(Decision {
                thought,
                calls,
                final_summary: None,
                content: outcome.content,
            }));
        }
        self.decide_json(messages).await
    }

    async fn decide_json(&mut self, messages: &mut Vec<Value>) -> Result<Option<Decision>, String> {
        let outcome = self.llm.chat_once_with(messages, None, None, Some(0.15)).await?;
        let raw = outcome.content.clone();
        let Some(payload) = crate::llm::parse_json_object(&raw) else {
            messages.push(json!({ "role": "assistant", "content": raw }));
            return Ok(None);
        };
        let tool = payload
            .get("tool")
            .or_else(|| payload.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = payload
            .get("args")
            .or_else(|| payload.get("arguments"))
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let call = json!({
            "id": format!("json_{}", self.stats.steps),
            "name": tool,
            "arguments": args,
        });
        let final_summary = payload
            .get("final")
            .or_else(|| payload.get("summary"))
            .and_then(Value::as_str)
            .map(|text| text.to_string());
        Ok(Some(Decision {
            thought: payload
                .get("thought")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            calls: if tool.is_empty() { Vec::new() } else { vec![call] },
            final_summary,
            content: raw,
        }))
    }

    async fn execute(&mut self, call: &Value, toolbox: &mut Toolbox) -> crate::toolbox::ToolResult {
        let name = call.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let args = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let started = Instant::now();
        let result = toolbox.call(&name, &args).await;
        let duration = started.elapsed().as_millis() as u64;
        self.stats.tool_calls += 1;
        if !result.ok {
            self.stats.failed_calls += 1;
        }
        let preview: String = result.content.replace('\n', " ").chars().take(160).collect();
        self.emit(
            "agent.tool",
            json!({
                "id": call.get("id").and_then(Value::as_str).unwrap_or("call"),
                "tool": name,
                "args": args,
                "ok": result.ok,
                "durationMs": duration,
                "observation": result.content.chars().take(2000).collect::<String>(),
                "preview": preview,
            }),
        );
        let head: String = preview.chars().take(140).collect();
        self.log(
            &format!("工具 {name} {} · {head}", if result.ok { "成功" } else { "失败" }),
            if result.ok { "info" } else { "warn" },
        );
        result
    }

    fn append_observation(
        &self,
        messages: &mut Vec<Value>,
        call: &Value,
        observation: &str,
        decision: &Decision,
    ) {
        let id = call.get("id").and_then(Value::as_str).unwrap_or("call");
        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
        let args = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if self.protocol == "tools" {
            messages.push(json!({
                "role": "assistant",
                "content": decision.thought,
                "tool_calls": [{
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string()),
                    }
                }],
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": id, "content": observation }));
        } else {
            let raw = if decision.content.trim().is_empty() {
                serde_json::to_string(&json!({ "tool": name, "args": args })).unwrap_or_default()
            } else {
                decision.content.clone()
            };
            messages.push(json!({ "role": "assistant", "content": raw }));
            messages.push(json!({ "role": "user", "content": observation }));
        }
    }

    fn compact(&self, messages: Vec<Value>) -> Vec<Value> {
        let total: usize = messages
            .iter()
            .map(|message| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|text| text.chars().count())
                    .unwrap_or(0)
            })
            .sum();
        if total <= CONTEXT_CHAR_BUDGET && messages.len() <= 40 {
            return messages;
        }
        if messages.len() <= 12 {
            return messages;
        }
        let head: Vec<Value> = messages.iter().take(2).cloned().collect();
        let tail: Vec<Value> = messages[messages.len() - 10..].to_vec();
        let dropped = messages.len() - head.len() - tail.len();
        if dropped == 0 {
            return messages;
        }
        self.log(&format!("上下文压缩：省略 {dropped} 条较早消息"), "debug");
        let mut compacted = head;
        compacted.push(json!({
            "role": "user",
            "content": format!("（已省略 {dropped} 条较早的工具交互，继续当前任务）"),
        }));
        compacted.extend(tail);
        compacted
    }

    async fn verify(&mut self, toolbox: &mut Toolbox, messages: &mut Vec<Value>, _summary: &str) -> bool {
        let (test, typecheck, _) = repomap::detect_commands(&toolbox.root);
        let mut plan: Vec<String> = [test, typecheck].into_iter().flatten().collect();
        if plan.is_empty() || !self.config.allow_commands {
            return true;
        }
        for round_index in 0..=MAX_VERIFY_ROUNDS {
            if self.stopped() {
                break;
            }
            let mut failed: Vec<String> = Vec::new();
            for command in plan.iter().take(2) {
                let result = toolbox.run_shell(command, 300).await;
                let exit_code = result.meta.get("exitCode").cloned().unwrap_or(Value::Null);
                self.emit(
                    "agent.verify",
                    json!({
                        "command": command,
                        "ok": result.ok,
                        "exitCode": exit_code,
                        "output": result.content.chars().take(3000).collect::<String>(),
                    }),
                );
                self.log(
                    &format!("验证 {command} {}", if result.ok { "通过" } else { "失败" }),
                    if result.ok { "success" } else { "warn" },
                );
                if !result.ok {
                    let output: String = result.content.chars().take(2500).collect();
                    failed.push(format!("命令 {command} 失败：\n{output}"));
                }
            }
            if failed.is_empty() {
                self.stats.verify_rounds = round_index;
                return true;
            }
            if round_index >= MAX_VERIFY_ROUNDS {
                break;
            }
            self.stats.verify_rounds = round_index + 1;
            messages.push(json!({
                "role": "user",
                "content": format!("验证未通过，请先分析错误并修复，然后再次运行验证：\n\n{}", failed.join("\n\n")),
            }));
            while self.stats.steps < self.config.max_steps && !self.stopped() {
                self.stats.steps += 1;
                let decision = match self.decide(messages).await {
                    Ok(Some(decision)) => decision,
                    _ => break,
                };
                if decision.final_summary.is_some() {
                    break;
                }
                if decision.calls.is_empty() {
                    break;
                }
                for call in decision.calls.clone() {
                    let result = self.execute(&call, toolbox).await;
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                    let observation = format!(
                        "工具 {name} 返回：{}\n{}",
                        if result.ok { "成功" } else { "失败" },
                        result.content
                    );
                    self.append_observation(messages, &call, &observation, &decision);
                    if toolbox.finished {
                        break;
                    }
                }
                let compacted = self.compact(messages.clone());
                *messages = compacted;
            }
            let (test, typecheck, _) = repomap::detect_commands(&toolbox.root);
            plan = [test, typecheck].into_iter().flatten().collect();
        }
        false
    }
}
