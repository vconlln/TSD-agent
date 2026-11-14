//! 模型客户端：OpenAI 兼容的 /chat/completions，支持流式（SSE）与非流式。
//!
//! 三条必须守住的规则（与 Python 参照实现一致）：
//!   1. reasoning_content / reasoning 单独取出，不混进正文；
//!   2. 服务端不认 tools（400）时去掉工具重试一次；
//!   3. 服务端不支持流式时退回非流式，上层不需要写两套逻辑。

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

const REASONING_KEYS: [&str; 3] = ["reasoning_content", "reasoning", "thinking"];

#[derive(Clone, Debug)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub timeout: Duration,
    /// offlineMode 或 provider=offline 时视为不可用（与 Python llm_available 一致）
    pub offline: bool,
}

impl LlmConfig {
    pub fn from_settings(settings: &Value) -> Self {
        let engine = settings.get("engine").cloned().unwrap_or_else(|| json!({}));
        let base_url = engine
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        Self {
            base_url,
            api_key: engine.get("apiKey").and_then(Value::as_str).unwrap_or("").to_string(),
            model: engine
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("deepseek-chat")
                .to_string(),
            temperature: engine.get("temperature").and_then(Value::as_f64).unwrap_or(0.3),
            max_tokens: engine.get("maxTokens").and_then(Value::as_u64).unwrap_or(8192) as u32,
            timeout: Duration::from_secs(
                engine.get("timeoutSec").and_then(Value::as_u64).unwrap_or(300).max(10),
            ),
            offline: engine.get("offlineMode").and_then(Value::as_bool).unwrap_or(false)
                || engine.get("provider").and_then(Value::as_str) == Some("offline"),
        }
    }

    /// 直接从工作区配置构造（经 settings 模块合并默认值 / 环境变量）
    pub fn from_workspace(workspace: &std::path::Path) -> Self {
        Self::from_settings(&crate::settings::load(workspace))
    }

    pub fn available(&self) -> bool {
        !self.offline && !self.base_url.is_empty() && !self.api_key.is_empty()
    }

    pub fn endpoint(&self) -> String {
        if self.base_url.ends_with("/chat/completions") {
            self.base_url.clone()
        } else {
            format!("{}/chat/completions", self.base_url)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug)]
pub enum Chunk {
    Reasoning(String),
    Content(String),
    ToolCalls(Vec<ToolCall>),
    Done,
}

pub struct StreamOutcome {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
}

fn extract_reasoning(message: &Value) -> String {
    for key in REASONING_KEYS {
        if let Some(text) = message.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn parse_tool_calls(message: &Value) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    if let Some(list) = message.get("tool_calls").and_then(Value::as_array) {
        for item in list {
            let function = item.get("function").cloned().unwrap_or_else(|| json!({}));
            let raw_args = function.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let arguments = match raw_args {
                Value::String(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
                other => other,
            };
            calls.push(ToolCall {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("call_0")
                    .to_string(),
                name: function.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                arguments,
            });
        }
    }
    calls
}

pub struct Llm {
    pub config: LlmConfig,
    client: Client,
}

impl Llm {
    pub fn new(config: LlmConfig) -> Self {
        let client = Client::builder()
            .timeout(config.timeout)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { config, client }
    }

    fn payload(&self, messages: &[Value], tools: Option<&Value>, stream: bool) -> Value {
        self.payload_with(messages, tools, stream, None, None, false)
    }

    fn payload_with(
        &self,
        messages: &[Value],
        tools: Option<&Value>,
        stream: bool,
        max_tokens: Option<u32>,
        temperature: Option<f64>,
        json_mode: bool,
    ) -> Value {
        let mut payload = json!({
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature.unwrap_or(self.config.temperature),
            "max_tokens": max_tokens.unwrap_or(self.config.max_tokens),
            "stream": stream,
        });
        if let Some(tools) = tools {
            payload["tools"] = tools.clone();
            payload["tool_choice"] = json!("auto");
        }
        if json_mode {
            payload["response_format"] = json!({ "type": "json_object" });
        }
        payload
    }

    /// 流式对话：逐块回调，返回累计结果。tools 为 None 时不发工具。
    pub async fn stream_chat<F>(
        &self,
        messages: &[Value],
        tools: Option<&Value>,
        mut on_chunk: F,
    ) -> Result<StreamOutcome, String>
    where
        F: FnMut(Chunk),
    {
        let mut outcome = StreamOutcome {
            content: String::new(),
            reasoning: String::new(),
            tool_calls: Vec::new(),
        };

        let response = self
            .client
            .post(self.config.endpoint())
            .bearer_auth(&self.config.api_key)
            .json(&self.payload(messages, tools, true))
            .send()
            .await
            .map_err(|error| format!("模型请求失败：{error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let message = body.replace('\n', " ");
            if message.to_lowercase().contains("tool") || status.as_u16() == 400 && tools.is_some() {
                return Err(format!("tools-unsupported:{status}:{}", &message[..message.len().min(300)]));
            }
            return Err(format!("模型返回 {status}：{}", &message[..message.len().min(300)]));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        // 工具调用是按 index 增量拼的
        let mut call_slots: std::collections::BTreeMap<u64, (String, String, String)> =
            std::collections::BTreeMap::new();
        let mut saw_any = false;

        while let Some(next) = stream.next().await {
            let bytes = next.map_err(|error| format!("读取模型流失败：{error}"))?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(index) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..index + 2).collect();
                for line in frame.lines() {
                    let Some(rest) = line.strip_prefix("data:") else { continue };
                    let payload = rest.trim();
                    if payload.is_empty() {
                        continue;
                    }
                    if payload == "[DONE]" {
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(payload) else { continue };
                    saw_any = true;
                    if let Some(usage) = value.get("usage") {
                        let _ = usage;
                    }
                    let Some(choices) = value.get("choices").and_then(Value::as_array) else { continue };
                    for choice in choices {
                        let delta = choice.get("delta").cloned().unwrap_or_else(|| json!({}));
                        let reasoning = extract_reasoning(&delta);
                        if !reasoning.is_empty() {
                            outcome.reasoning.push_str(&reasoning);
                            on_chunk(Chunk::Reasoning(reasoning));
                        }
                        if let Some(text) = delta.get("content").and_then(Value::as_str) {
                            if !text.is_empty() {
                                outcome.content.push_str(text);
                                on_chunk(Chunk::Content(text.to_string()));
                            }
                        }
                        if let Some(list) = delta.get("tool_calls").and_then(Value::as_array) {
                            for item in list {
                                let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
                                let slot = call_slots.entry(index).or_default();
                                if let Some(id) = item.get("id").and_then(Value::as_str) {
                                    slot.0 = id.to_string();
                                }
                                if let Some(function) = item.get("function") {
                                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                                        slot.1 = name.to_string();
                                    }
                                    match function.get("arguments") {
                                        Some(Value::String(text)) => slot.2.push_str(text),
                                        Some(other) => slot.2.push_str(&other.to_string()),
                                        None => {}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if !saw_any {
            return Err("stream-unsupported".to_string());
        }

        for (id, name, raw_args) in call_slots.values() {
            let arguments = serde_json::from_str::<Value>(raw_args).unwrap_or_else(|_| json!({}));
            outcome.tool_calls.push(ToolCall {
                id: if id.is_empty() { "call_0".to_string() } else { id.clone() },
                name: name.clone(),
                arguments,
            });
        }
        if !outcome.tool_calls.is_empty() {
            on_chunk(Chunk::ToolCalls(outcome.tool_calls.clone()));
        }
        on_chunk(Chunk::Done);
        Ok(outcome)
    }

    /// 非流式：网关不支持 stream 时用
    pub async fn chat_once(
        &self,
        messages: &[Value],
        tools: Option<&Value>,
    ) -> Result<StreamOutcome, String> {
        self.chat_once_with(messages, tools, None, None).await
    }

    /// 非流式 + 覆盖采样参数（编辑器内 AI 用短输出）
    pub async fn chat_once_with(
        &self,
        messages: &[Value],
        tools: Option<&Value>,
        max_tokens: Option<u32>,
        temperature: Option<f64>,
    ) -> Result<StreamOutcome, String> {
        let response = self
            .client
            .post(self.config.endpoint())
            .bearer_auth(&self.config.api_key)
            .json(&self.payload_with(messages, tools, false, max_tokens, temperature, false))
            .send()
            .await
            .map_err(|error| format!("模型请求失败：{error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("模型返回 {status}：{}", &body.replace('\n', " ")[..body.len().min(300)]));
        }
        let value: Value = response.json().await.map_err(|error| format!("模型返回不是 JSON：{error}"))?;
        let message = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        Ok(StreamOutcome {
            content: message.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
            reasoning: extract_reasoning(&message),
            tool_calls: parse_tool_calls(&message),
        })
    }

    /// 结构化输出：先要求 response_format=json_object，网关不认就去掉重试一次。
    /// 返回 None 表示模型没给出可解析的 JSON（调用方决定怎么降级）。
    pub async fn chat_json(
        &self,
        messages: &[Value],
        max_tokens: u32,
        temperature: f64,
    ) -> Result<Option<Value>, String> {
        for json_mode in [true, false] {
            let response = self
                .client
                .post(self.config.endpoint())
                .bearer_auth(&self.config.api_key)
                .json(&self.payload_with(
                    messages,
                    None,
                    false,
                    Some(max_tokens),
                    Some(temperature),
                    json_mode,
                ))
                .send()
                .await
                .map_err(|error| format!("模型请求失败：{error}"))?;
            if !response.status().is_success() {
                if json_mode {
                    // 网关不支持 response_format：去掉重试
                    continue;
                }
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(format!(
                    "模型返回 {status}：{}",
                    body.replace('\n', " ").chars().take(300).collect::<String>()
                ));
            }
            let value: Value = response
                .json()
                .await
                .map_err(|error| format!("模型返回不是 JSON：{error}"))?;
            let text = value
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Some(parsed) = parse_json_object(&text) {
                return Ok(Some(parsed));
            }
            if !json_mode {
                return Ok(None);
            }
        }
        Ok(None)
    }
}

/// 从模型输出里抓第一个 JSON 对象（容忍代码围栏与前后说明文字）
fn parse_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if value.is_object() {
            return Some(value);
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end])
        .ok()
        .filter(Value::is_object)
}

