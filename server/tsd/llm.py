from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .parser import use_env_proxy


class LLMError(RuntimeError):
    pass


class LLMClient:
    """最小可用的 OpenAI 兼容客户端（DeepSeek / OpenAI / vLLM / Ollama 均可）。"""

    def __init__(self, engine: dict[str, Any]) -> None:
        self.engine = engine
        self.base_url = (engine.get("baseUrl") or "").rstrip("/")
        self.api_key = (engine.get("apiKey") or "").strip()
        self.model = engine.get("model") or "deepseek-chat"
        self.temperature = float(engine.get("temperature") or 0.3)
        self.max_tokens = int(engine.get("maxTokens") or 8192)
        self.timeout = float(engine.get("timeoutSec") or 300)
        self.usage: dict[str, int] = {}

    # ------------------------------------------------------------------
    def available(self) -> bool:
        if self.engine.get("offlineMode") or self.engine.get("provider") == "offline":
            return False
        return bool(self.base_url) and bool(self.api_key)

    @property
    def endpoint(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        return f"{self.base_url}/chat/completions"

    # ------------------------------------------------------------------
    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.available():
            raise LLMError("未配置可用的模型服务")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            # 本机模型（mock / Ollama / vLLM）不走代理，避免企业代理或 socks 环境被拦
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=use_env_proxy(self.endpoint)) as client:
                response = await client.post(self.endpoint, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise LLMError(f"模型请求失败：{exc}") from exc

        if response.status_code >= 400:
            snippet = response.text[:400].replace("\n", " ")
            raise LLMError(f"模型返回 {response.status_code}：{snippet}")

        try:
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            raise LLMError("模型返回的不是 JSON") from exc

        usage = data.get("usage") or {}
        if usage:
            self.usage["inputTokens"] = self.usage.get("inputTokens", 0) + int(usage.get("prompt_tokens") or 0)
            self.usage["outputTokens"] = self.usage.get("outputTokens", 0) + int(usage.get("completion_tokens") or 0)
        return data

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
        json_mode: bool = False,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": max_tokens or self.max_tokens,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        data = await self._post(payload)
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        if not content.strip():
            raise LLMError("模型返回了空内容")
        return content

    async def chat_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        """原生 function calling。

        返回 {content, tool_calls, raw}。若服务端不支持 tools 参数（部分自建
        网关会直接 400），抛出 LLMError("tools-unsupported") 供上层回退到
        JSON 协议，而不是把整个任务判死。
        """
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": max_tokens or self.max_tokens,
            "stream": False,
            "tools": tools,
            "tool_choice": "auto",
        }
        try:
            data = await self._post(payload)
        except LLMError as exc:
            message = str(exc).lower()
            if "tools" in message or "tool_choice" in message or "400" in message:
                raise LLMError("tools-unsupported") from exc
            raise
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        tool_calls = message.get("tool_calls") or []
        normalized: list[dict[str, Any]] = []
        for call in tool_calls:
            function = call.get("function") or {}
            raw_args = function.get("arguments")
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args or "{}")
                except Exception:
                    args = {"__raw": raw_args}
            elif isinstance(raw_args, dict):
                args = raw_args
            else:
                args = {}
            normalized.append(
                {
                    "id": call.get("id") or f"call_{len(normalized)}",
                    "name": function.get("name") or "",
                    "arguments": args if isinstance(args, dict) else {},
                }
            )
        return {
            "content": message.get("content") or "",
            "tool_calls": normalized,
            "raw": message,
        }

    # ------------------------------------------------------------------
    @staticmethod
    def extract_json(text: str) -> dict[str, Any] | None:
        if not text:
            return None
        candidates: list[str] = []
        fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
        if fence:
            candidates.append(fence.group(1))
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            candidates.append(text[start : end + 1])
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                continue
        return None

    async def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> dict[str, Any] | None:
        try:
            raw = await self.chat(messages, max_tokens=max_tokens, temperature=temperature, json_mode=True)
        except LLMError:
            raw = await self.chat(messages, max_tokens=max_tokens, temperature=temperature, json_mode=False)
        return self.extract_json(raw)


SYSTEM_ARCHITECT = (
    "你是一位资深软件架构师与重构专家，服务于自动化项目升级流水线。"
    "你的输出必须严谨、可执行、面向真实代码库，避免空话。"
    "所有说明使用简体中文，代码与路径保持原样。"
)

SYSTEM_CODER = (
    "你是一位严谨的高级工程师，负责在既有代码库上实施升级改造。"
    "你只输出 JSON，不输出解释性文字或 Markdown 代码围栏。"
    "所有文件内容必须是完整可写盘的最终版本，不要使用省略号。"
)
