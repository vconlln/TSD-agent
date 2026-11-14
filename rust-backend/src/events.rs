//! 事件中心：每个 run 一条通道。
//!
//! 前端只依赖三件事（见 docs/BACKEND-INTEGRATION.md 第 4 节）：
//!   1. seq 在同一个 run 内从 1 单调递增；
//!   2. GET /events?since=N 先补发 seq > N 的历史，再接实时；
//!   3. run.done / run.error 是终止事件。
//!
//! 事件同时追加写入 runs/<runId>.events.jsonl，进程重启后仍可回放。

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

const HISTORY_LIMIT: usize = 4000;
const BROADCAST_LIMIT: usize = 256;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub ts: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Event {
    pub fn is_terminal(&self) -> bool {
        self.kind == "run.done" || self.kind == "run.error"
    }
}

pub struct RunChannel {
    pub run_id: String,
    seq: AtomicU64,
    events: Mutex<Vec<Event>>,
    tx: broadcast::Sender<Event>,
    closed: AtomicBool,
    log_path: Option<PathBuf>,
}

impl RunChannel {
    pub fn new(run_id: &str, log_path: Option<PathBuf>) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(BROADCAST_LIMIT);
        Arc::new(Self {
            run_id: run_id.to_string(),
            seq: AtomicU64::new(0),
            events: Mutex::new(Vec::new()),
            tx,
            closed: AtomicBool::new(false),
            log_path,
        })
    }

    /// 发一条事件：分配 seq、入历史、广播、落盘。
    pub fn emit(&self, kind: &str, data: Option<Value>) -> Event {
        self.emit_full(kind, None, None, None, None, data)
    }

    pub fn emit_full(
        &self,
        kind: &str,
        step: Option<String>,
        level: Option<String>,
        message: Option<String>,
        delta: Option<String>,
        data: Option<Value>,
    ) -> Event {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = Event {
            seq,
            run_id: self.run_id.clone(),
            ts: now_ms(),
            kind: kind.to_string(),
            step,
            level,
            message,
            delta,
            data,
        };
        if let Ok(mut history) = self.events.lock() {
            history.push(event.clone());
            if history.len() > HISTORY_LIMIT {
                let drain = history.len() - HISTORY_LIMIT;
                history.drain(0..drain);
            }
        }
        let _ = self.tx.send(event.clone());
        if event.is_terminal() {
            self.closed.store(true, Ordering::SeqCst);
        }
        if let Some(path) = &self.log_path {
            if let Ok(line) = serde_json::to_string(&event) {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(file, "{}", line);
                }
            }
        }
        event
    }

    pub fn log(&self, level: &str, message: &str, step: Option<&str>) {
        self.emit_full(
            "log",
            step.map(|s| s.to_string()),
            Some(level.to_string()),
            Some(message.to_string()),
            None,
            None,
        );
    }

    pub fn history_since(&self, since: u64) -> Vec<Event> {
        self.events
            .lock()
            .map(|history| {
                history
                    .iter()
                    .filter(|event| event.seq > since)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

/// 进程内的 run 通道注册表
#[derive(Default)]
pub struct EventHub {
    channels: Mutex<HashMap<String, Arc<RunChannel>>>,
}

impl EventHub {
    pub fn create(&self, run_id: &str, log_path: Option<PathBuf>) -> Arc<RunChannel> {
        let channel = RunChannel::new(run_id, log_path);
        if let Ok(mut map) = self.channels.lock() {
            map.insert(run_id.to_string(), channel.clone());
        }
        channel
    }

    pub fn get(&self, run_id: &str) -> Option<Arc<RunChannel>> {
        self.channels
            .lock()
            .ok()
            .and_then(|map| map.get(run_id).cloned())
    }
}
