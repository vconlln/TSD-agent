#!/usr/bin/env python3
"""TSD Agent Python 后端入口。

用法：
    python server/main.py --port 8791 --workspace ./work
    python server/main.py --help

打包（PyInstaller）：
    pyinstaller server/tsd_server.spec
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tsd import __version__  # noqa: E402
from tsd.api import create_app  # noqa: E402


def default_workspace() -> Path:
    env = os.environ.get("TSD_WORKSPACE")
    if env:
        return Path(env).expanduser()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "TSD-Agent" / "workspace"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="TSD Agent backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--workspace", default=str(default_workspace()))
    parser.add_argument("--reload", action="store_true", help="开发模式自动重载")
    args = parser.parse_args()

    workspace = Path(args.workspace).expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)

    import uvicorn

    app = create_app(workspace)
    print(f"[tsd] TSD Agent backend v{__version__}", flush=True)
    print(f"[tsd] workspace: {workspace}", flush=True)
    print(f"[tsd] listening: http://{args.host}:{args.port}", flush=True)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=False,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
