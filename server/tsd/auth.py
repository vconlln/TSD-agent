from __future__ import annotations

"""W3 访问凭证。

前端只需要登录状态与模型清单，真正的 W3 网关地址属于内网信息，因此这里：
- 配置了 w3.serverUrl 时，走真实网关（登录 + 模型列表）；
- 未配置时进入演示模式，签发本地演示凭证并返回内置模型清单，
  便于在前端把交互与后续联调全部打通。

密码永远不会落盘，只缓存 token / 用户信息 / 过期时间。
"""

import time
import uuid
from typing import Any

import httpx

from .config import SettingsStore

DEMO_PASSWORD_MIN = 4
DEFAULT_TTL_SECONDS = 8 * 3600

BUILTIN_MODELS: list[dict[str, Any]] = [
    {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat",
        "provider": "deepseek",
        "contextWindow": 65536,
        "tags": ["通用", "快速"],
        "recommended": True,
    },
    {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner",
        "provider": "deepseek",
        "contextWindow": 65536,
        "tags": ["推理", "长文"],
    },
    {
        "id": "qwen2.5-coder-32b",
        "name": "Qwen2.5 Coder 32B",
        "provider": "internal",
        "contextWindow": 131072,
        "tags": ["代码", "内部"],
    },
    {
        "id": "internal-large",
        "name": "内部大模型 Large",
        "provider": "internal",
        "contextWindow": 131072,
        "tags": ["内部", "长上下文"],
    },
]


class W3AuthError(RuntimeError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _now_ms() -> int:
    return int(time.time() * 1000)


class W3Auth:
    def __init__(self, settings: SettingsStore) -> None:
        self.settings = settings
        self._session: dict[str, Any] | None = None
        self._models: list[dict[str, Any]] = []
        self._restore()

    # ------------------------------------------------------------------
    def _restore(self) -> None:
        w3 = self.settings.w3()
        token = str(w3.get("token") or "")
        expires_at = int(w3.get("expiresAt") or 0)
        if token and expires_at > _now_ms():
            self._session = {
                "token": token,
                "user": w3.get("user") or {},
                "expiresAt": expires_at,
                "mode": w3.get("mode") or "w3",
            }

    def _persist(self) -> None:
        if self._session is None:
            self.settings.update_w3({"token": "", "user": {}, "expiresAt": 0, "mode": ""})
            return
        self.settings.update_w3(
            {
                "token": self._session["token"],
                "user": self._session["user"],
                "expiresAt": self._session["expiresAt"],
                "mode": self._session["mode"],
            }
        )

    # ------------------------------------------------------------------
    @property
    def configured(self) -> bool:
        return bool((self.settings.w3().get("serverUrl") or "").strip())

    def token(self) -> str:
        if self._session is None:
            return ""
        if int(self._session.get("expiresAt") or 0) <= _now_ms():
            self._session = None
            self._persist()
            return ""
        return str(self._session.get("token") or "")

    def status(self) -> dict[str, Any]:
        token = self.token()
        w3 = self.settings.w3()
        if not token or self._session is None:
            return {
                "authenticated": False,
                "configured": self.configured,
                "mode": "w3" if self.configured else "demo",
                "rememberUsername": w3.get("rememberUsername") or "",
                "models": [],
            }
        return {
            "authenticated": True,
            "configured": self.configured,
            "mode": self._session["mode"],
            "user": self._session["user"],
            "expiresAt": self._session["expiresAt"],
            "tokenPreview": _preview(token),
            "rememberUsername": w3.get("rememberUsername") or "",
            "models": self._models,
        }

    # ------------------------------------------------------------------
    async def login(self, username: str, password: str) -> dict[str, Any]:
        username = (username or "").strip()
        if not username:
            raise W3AuthError("请输入用户名", 400)
        if not password:
            raise W3AuthError("请输入密码", 400)

        w3 = self.settings.w3()
        server = (w3.get("serverUrl") or "").strip().rstrip("/")
        if server:
            session = await self._remote_login(server, w3, username, password)
        else:
            session = self._demo_login(username, password)

        self._session = session
        self.settings.update_w3({"rememberUsername": username})
        self._persist()
        self._models = await self._load_models()
        return self.status()

    def _demo_login(self, username: str, password: str) -> dict[str, Any]:
        if len(password) < DEMO_PASSWORD_MIN:
            raise W3AuthError(f"演示模式下密码至少 {DEMO_PASSWORD_MIN} 位", 400)
        return {
            "token": f"demo-{uuid.uuid4().hex[:24]}",
            "user": {
                "id": f"demo-{username}",
                "name": username,
                "email": "",
                "department": "演示租户",
            },
            "expiresAt": _now_ms() + DEFAULT_TTL_SECONDS * 1000,
            "mode": "demo",
        }

    async def _remote_login(
        self,
        server: str,
        w3: dict[str, Any],
        username: str,
        password: str,
    ) -> dict[str, Any]:
        login_url = server + (w3.get("loginPath") or "/api/v1/auth/login")
        payload = {"username": username, "password": password}
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(login_url, json=payload)
        except httpx.HTTPError as exc:
            raise W3AuthError(f"无法连接 W3 服务：{exc}", 502) from exc

        if response.status_code == 401:
            raise W3AuthError("用户名或密码错误", 401)
        if response.status_code >= 400:
            detail = ""
            try:
                body = response.json()
                detail = str(body.get("message") or body.get("detail") or "")
            except Exception:
                detail = response.text[:200]
            raise W3AuthError(f"W3 登录失败（{response.status_code}）{detail}".strip(), 502)

        try:
            body = response.json()
        except Exception as exc:  # noqa: BLE001
            raise W3AuthError("W3 返回内容不是 JSON", 502) from exc

        token = str(body.get("token") or body.get("accessToken") or body.get("access_token") or "")
        if not token:
            raise W3AuthError("W3 未返回访问凭证", 502)
        user = body.get("user") or body.get("profile") or {}
        if not isinstance(user, dict):
            user = {"name": str(user)}
        user.setdefault("name", username)
        ttl = body.get("expiresIn") or body.get("expiresInSec") or DEFAULT_TTL_SECONDS
        try:
            ttl_seconds = int(ttl)
        except (TypeError, ValueError):
            ttl_seconds = DEFAULT_TTL_SECONDS
        return {
            "token": token,
            "user": user,
            "expiresAt": _now_ms() + max(60, ttl_seconds) * 1000,
            "mode": "w3",
        }

    # ------------------------------------------------------------------
    async def _load_models(self) -> list[dict[str, Any]]:
        w3 = self.settings.w3()
        server = (w3.get("serverUrl") or "").strip().rstrip("/")
        if not server or self._session is None or self._session["mode"] != "w3":
            return [dict(model) for model in BUILTIN_MODELS]

        url = server + (w3.get("modelsPath") or "/api/v1/models")
        headers = {"Authorization": f"Bearer {self._session['token']}"}
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, headers=headers)
            if response.status_code >= 400:
                raise W3AuthError(f"模型列表获取失败（{response.status_code}）", 502)
            body = response.json()
        except (httpx.HTTPError, ValueError, W3AuthError):
            return [dict(model) for model in BUILTIN_MODELS]

        raw: Any = body
        if isinstance(body, dict):
            raw = body.get("models") or body.get("data") or body.get("items") or []
        models: list[dict[str, Any]] = []
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                model_id = str(item.get("id") or item.get("model") or item.get("name") or "")
                if not model_id:
                    continue
                models.append(
                    {
                        "id": model_id,
                        "name": str(item.get("name") or item.get("displayName") or model_id),
                        "provider": str(item.get("provider") or "w3"),
                        "contextWindow": item.get("contextWindow") or item.get("context_length"),
                        "tags": item.get("tags") if isinstance(item.get("tags"), list) else [],
                    }
                )
        return models or [dict(model) for model in BUILTIN_MODELS]

    async def ensure_models(self) -> None:
        """会话从配置恢复后模型清单为空，这里按需补拉一次。"""
        if self.token() and not self._models:
            self._models = await self._load_models()

    async def models(self) -> dict[str, Any]:
        if not self.token():
            raise W3AuthError("尚未登录 W3", 401)
        if not self._models:
            self._models = await self._load_models()
        mode = self._session["mode"] if self._session else "demo"
        return {"models": self._models, "source": "w3" if mode == "w3" else "builtin"}

    def logout(self) -> dict[str, Any]:
        self._session = None
        self._models = []
        self._persist()
        return {"ok": True}


def _preview(token: str) -> str:
    if len(token) <= 10:
        return token[:4] + "…"
    return f"{token[:6]}…{token[-4:]}"
