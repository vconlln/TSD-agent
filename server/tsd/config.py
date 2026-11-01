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

DEFAULT_W3: dict[str, Any] = {
    # Empty serverUrl keeps the credential flow in demo mode (local token), so
    # the UI can be wired before the internal gateway address is known.
    "serverUrl": "",
    "loginPath": "/api/v1/auth/login",
    "modelsPath": "/api/v1/models",
    "rememberUsername": "",
    # Cached session so a restart keeps working until the credential expires.
    "token": "",
    "user": {},
    "expiresAt": 0,
    "mode": "",
}

DEFAULT_AGENT: dict[str, Any] = {
    # auto：优先 function calling，模型不支持时自动降级为 JSON 协议
    # single：回到一次性生成（旧行为，适合只支持纯文本补全的模型）
    "mode": "auto",
    "maxSteps": 24,
    "allowCommands": True,
    "verify": True,
    "deadlineSeconds": 900,
    "maxObservationChars": 6000,
}

DEFAULT_GIT: dict[str, Any] = {
    # local | gitlab | github | generic
    "provider": "local",
    "baseUrl": "",
    "token": "",
    "reposPath": "/api/v4/projects",
    # Directory scanned for repositories when provider is "local".
    "reposRoot": "",
    "defaultBranch": "main",
    "authorName": "TSD Agent",
    "authorEmail": "tsd-agent@localhost",
}

DEFAULTS: dict[str, Any] = {
    "engine": DEFAULT_ENGINE,
    "agent": DEFAULT_AGENT,
    "w3": DEFAULT_W3,
    "git": DEFAULT_GIT,
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
        # 出厂默认配置：打包时可以把内网网关地址 / 模型名预置进 resources/defaults.json，
        # 用户第一次启动就带着内网地址，不需要手工填（TSD_DEFAULTS_FILE 指向该文件）。
        bundled = os.environ.get("TSD_DEFAULTS_FILE")
        if bundled:
            try:
                path = Path(bundled)
                if path.exists():
                    preset = json.loads(path.read_text("utf-8"))
                    if isinstance(preset, dict):
                        for block, defaults in (
                            ("engine", DEFAULT_ENGINE),
                            ("agent", DEFAULT_AGENT),
                            ("w3", DEFAULT_W3),
                            ("git", DEFAULT_GIT),
                        ):
                            values = preset.get(block) or {}
                            if isinstance(values, dict):
                                data[block] = {
                                    **data[block],
                                    **{k: v for k, v in values.items() if k in defaults},
                                }
                        for key in ("concurrency", "autoApplyChatEdits", "language"):
                            if key in preset:
                                data[key] = preset[key]
            except Exception:
                pass
        try:
            if self.path.exists():
                raw = json.loads(self.path.read_text("utf-8"))
                if isinstance(raw, dict):
                    engine = raw.pop("engine", {}) or {}
                    w3 = raw.pop("w3", {}) or {}
                    git = raw.pop("git", {}) or {}
                    agent = raw.pop("agent", {}) or {}
                    data.update({k: v for k, v in raw.items() if k in DEFAULTS})
                    data["engine"] = {**DEFAULT_ENGINE, **{k: v for k, v in engine.items() if k in DEFAULT_ENGINE}}
                    data["agent"] = {**DEFAULT_AGENT, **{k: v for k, v in agent.items() if k in DEFAULT_AGENT}}
                    data["w3"] = {**DEFAULT_W3, **{k: v for k, v in w3.items() if k in DEFAULT_W3}}
                    data["git"] = {**DEFAULT_GIT, **{k: v for k, v in git.items() if k in DEFAULT_GIT}}
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
    def w3(self) -> dict[str, Any]:
        return dict(self._data["w3"])

    def git(self) -> dict[str, Any]:
        return dict(self._data["git"])

    def agent(self) -> dict[str, Any]:
        return dict(self._data["agent"])

    def public(self) -> dict[str, Any]:
        engine = self._data["engine"]
        w3 = self._data["w3"]
        git = self._data["git"]
        agent = self._data["agent"]
        return {
            "agent": {
                "mode": agent["mode"],
                "maxSteps": agent["maxSteps"],
                "allowCommands": agent["allowCommands"],
                "verify": agent["verify"],
                "deadlineSeconds": agent["deadlineSeconds"],
                "maxObservationChars": agent["maxObservationChars"],
            },
            "w3": {
                "serverUrl": w3["serverUrl"],
                "loginPath": w3["loginPath"],
                "modelsPath": w3["modelsPath"],
                "rememberUsername": w3["rememberUsername"],
                "configured": bool(w3["serverUrl"]),
            },
            "git": {
                "provider": git["provider"],
                "baseUrl": git["baseUrl"],
                "tokenSet": bool(git["token"]),
                "reposPath": git["reposPath"],
                "reposRoot": git["reposRoot"],
                "defaultBranch": git["defaultBranch"],
                "authorName": git["authorName"],
                "authorEmail": git["authorEmail"],
            },
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

    def update_w3(self, patch: dict[str, Any]) -> None:
        with self._lock:
            for key, value in patch.items():
                if key in DEFAULT_W3:
                    self._data["w3"][key] = value
            self._save()

    def update_git(self, patch: dict[str, Any]) -> None:
        with self._lock:
            for key, value in patch.items():
                if key in DEFAULT_GIT:
                    self._data["git"][key] = value
            self._save()

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if isinstance(patch.get("agent"), dict):
                for key, value in patch["agent"].items():
                    if key in DEFAULT_AGENT and value is not None:
                        self._data["agent"][key] = value
            if isinstance(patch.get("w3"), dict):
                for key, value in patch["w3"].items():
                    if key in DEFAULT_W3:
                        self._data["w3"][key] = value
            if isinstance(patch.get("git"), dict):
                for key, value in patch["git"].items():
                    if key == "token" and isinstance(value, str):
                        self._data["git"]["token"] = value.strip()
                        continue
                    if key in DEFAULT_GIT:
                        self._data["git"][key] = value
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
