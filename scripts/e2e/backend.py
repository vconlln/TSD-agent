"""e2e 后端选择：默认跑 Python 参照实现，设 --backend rust（或 TSD_BACKEND_BIN）时跑 Rust 后端。

同一套断言跑两边，是迁移期证明「契约等价」最省事的方式。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

BACKEND_FLAG = "--backend"
BACKEND_ENV = "TSD_BACKEND_BIN"


def rust_binary() -> str:
    name = "tsd-server-rs.exe" if os.name == "nt" else "tsd-server-rs"
    return str(ROOT / "rust-backend" / "target" / "release" / name)


def wants_rust() -> bool:
    if os.environ.get(BACKEND_ENV, "").strip():
        return True
    if BACKEND_FLAG in sys.argv and "rust" in sys.argv:
        return True
    # 兼容用 argparse 解析 --backend 的脚本
    try:
        index = sys.argv.index(BACKEND_FLAG)
    except ValueError:
        return False
    return "rust" in sys.argv[index + 1 : index + 2]


def backend_command(port: int, workspace: Path) -> list[str]:
    binary = os.environ.get(BACKEND_ENV, "").strip()
    if not binary and wants_rust():
        binary = rust_binary()
    if binary:
        if not Path(binary).exists():
            raise SystemExit(f"找不到后端可执行文件：{binary}（先 npm run rust:build）")
        return [binary, "--port", str(port), "--workspace", str(workspace)]
    return [
        sys.executable,
        str(ROOT / "server" / "main.py"),
        "--port",
        str(port),
        "--workspace",
        str(workspace),
    ]
