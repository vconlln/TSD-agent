//! TSD Agent 后端（Rust 版）
//!
//! 第 1 层：只读契约（health / settings / projects / documents / diff / tree / file）。
//! 契约来源：仓库根 docs/BACKEND-INTEGRATION.md 与 shared/types.ts；
//! 验收：node scripts/contract-check.mjs --api http://127.0.0.1:<port> --read-only
//!
//! 用法：
//!   tsd-server-rs --port 8801 --host 127.0.0.1 --workspace /path/to/workspace

mod auth;
mod chat;
mod diff;
mod events;
mod gitops;
mod inline;
mod llm;
mod pipeline;
mod projects;
mod routes;
mod runs;
mod settings;
mod state;
mod store;

#[cfg(test)]
mod tests;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use tokio::net::TcpListener;

struct Args {
    port: u16,
    host: String,
    workspace: PathBuf,
}

fn parse_args() -> Args {
    let mut port: u16 = std::env::var("TSD_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8791);
    let mut host = std::env::var("TSD_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let mut workspace = std::env::var("TSD_WORKSPACE").unwrap_or_else(|_| "workspace".to_string());

    let args: Vec<String> = std::env::args().collect();
    let mut index = 1;
    while index < args.len() {
        let need = |i: usize| -> String { args.get(i).cloned().unwrap_or_default() };
        match args[index].as_str() {
            "--port" => {
                port = need(index + 1).parse().unwrap_or(port);
                index += 2;
            }
            "--host" => {
                host = need(index + 1);
                index += 2;
            }
            "--workspace" => {
                workspace = need(index + 1);
                index += 2;
            }
            "--help" | "-h" => {
                println!("tsd-server-rs --port 8791 --host 127.0.0.1 --workspace <dir>");
                std::process::exit(0);
            }
            _ => index += 1,
        }
    }

    Args {
        port,
        host,
        workspace: PathBuf::from(workspace),
    }
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let state = Arc::new(state::AppState::new(args.workspace.clone()));
    if let Err(error) = std::fs::create_dir_all(state.projects_dir()) {
        eprintln!("[tsd-rs] 无法创建工作区目录: {error}");
        std::process::exit(1);
    }

    let address: SocketAddr = match format!("{}:{}", args.host, args.port).parse() {
        Ok(addr) => addr,
        Err(error) => {
            eprintln!("[tsd-rs] 地址无效: {error}");
            std::process::exit(1);
        }
    };

    let listener = match TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[tsd-rs] 端口不可用 {address}: {error}");
            std::process::exit(1);
        }
    };

    println!("[tsd-rs] TSD Agent backend (Rust) v{}", state.version);
    println!("[tsd-rs] workspace: {}", state.workspace.display());
    println!("[tsd-rs] listening: http://{}", address);
    println!(
        "[tsd-rs] layers: 1 只读契约 · 2 运行与事件流 · 3 流式对话与改动提案"
    );

    let app = routes::router(state);
    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("[tsd-rs] 服务异常退出: {error}");
    }
}
