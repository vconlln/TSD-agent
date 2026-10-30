from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

DEFAULT_ENGINE: dict[str, Any] = {
    "provider": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "temperature": 0.3,
    "maxTokens": 8192,
    "timeoutSec": 300,
    "offlineMode": False,
    "apiKey": "",
}

DEFAULTS: dict[str, Any] = {
    "engine": DEFAULT_ENGINE,
    "concurrency": 2,
    "autoApplyChatEdits": False,
    "language": "zh-CN",
}


class SettingsStore:
    """工作区内的持久化配置（含 API Key，仅保存在本机）。"""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.path = workspace / ".tsd" / "config.json"
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        data = json.loads(json.dumps(DEFAULTS))
        try:
            if self.path.exists():
                raw = json.loads(self.path.read_text("utf-8"))
                if isinstance(raw, dict):
                    engine = raw.pop("engine", {}) or {}
                    data.update({k: v for k, v in raw.items() if k in DEFAULT_ENGINE or k in DEFAULTS})
                    merged = {**DEFAULT_ENGINE, **{k: v for k, v in engine.items() if k in DEFAULT_ENGINE}}
                    data["engine"] = merged
        except Exception:
            pass
        env_key = os.environ.get("TSD_LLM_API_KEY")
        if env_key:
            data["engine"]["apiKey"] = env_key
        if os.environ.get("TSD_LLM_BASE_URL"):
            data["engine"]["baseUrl"] = os.environ["TSD_LLM_BASE_URL"]
        if os.environ.get("TSD_LLM_MODEL"):
            data["engine"]["model"] = os.environ["TSD_LLM_MODEL"]
        return data

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2, ensure_ascii=False), "utf-8")
            tmp.replace(self.path)
        except Exception:
            pass

    # ------------------------------------------------------------------
    def public(self) -> dict[str, Any]:
        engine = self._data["engine"]
        return {
            "engine": {
                "provider": engine["provider"],
                "baseUrl": engine["baseUrl"],
                "model": engine["model"],
                "apiKeySet": bool(engine.get("apiKey")),
                "temperature": engine["temperature"],
                "maxTokens": engine["maxTokens"],
                "timeoutSec": engine["timeoutSec"],
                "offlineMode": engine["offlineMode"],
            },
            "workspace": str(self.workspace),
            "concurrency": self._data["concurrency"],
            "autoApplyChatEdits": self._data["autoApplyChatEdits"],
            "language": self._data["language"],
        }

    def engine(self) -> dict[str, Any]:
        return dict(self._data["engine"])

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if isinstance(patch.get("engine"), dict):
                incoming = patch["engine"]
                for key, value in incoming.items():
                    if key == "apiKey":
                        if isinstance(value, str) and value.strip():
                            self._data["engine"]["apiKey"] = value.strip()
                        continue
                    if key in DEFAULT_ENGINE and value is not None:
                        self._data["engine"][key] = value
            for key in ("concurrency", "autoApplyChatEdits", "language"):
                if key in patch and patch[key] is not None:
                    self._data[key] = patch[key]
            self._save()
        return self.public()

    def llm_available(self) -> bool:
        engine = self._data["engine"]
        if engine.get("offlineMode") or engine.get("provider") == "offline":
            return False
        return bool(engine.get("apiKey") and engine.get("baseUrl"))
