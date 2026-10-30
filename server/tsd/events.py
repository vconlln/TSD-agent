from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Iterable


class RunChannel:
    """一次运行的事件通道：支持回放 + 实时订阅，并持久化为 jsonl。"""

    def __init__(self, run_id: str, path: Path | None = None) -> None:
        self.run_id = run_id
        self.path = path
        self.events: list[dict[str, Any]] = []
        self._seq = 0
        self._subscribers: list[asyncio.Queue[dict[str, Any] | None]] = []
        self.closed = False
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self) -> None:
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    # ------------------------------------------------------------------
    def emit(
        self,
        type_: str,
        *,
        level: str | None = None,
        message: str | None = None,
        step: str | None = None,
        delta: str | None = None,
        data: dict[str, Any] | None = None,
        ts: float | None = None,
    ) -> dict[str, Any]:
        self._seq += 1
        event: dict[str, Any] = {
            "seq": self._seq,
            "runId": self.run_id,
            "ts": int((ts or time.time()) * 1000),
            "type": type_,
        }
        if level:
            event["level"] = level
        if message is not None:
            event["message"] = message
        if step:
            event["step"] = step
        if delta is not None:
            event["delta"] = delta
        if data:
            event["data"] = data
        self.events.append(event)
        if len(self.events) > 6000:
            self.events = self.events[-3000:]
        if self.path:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            except Exception:
                pass
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except Exception:
                pass
        return event

    def log(self, message: str, level: str = "info", *, step: str | None = None) -> None:
        self.emit("log", level=level, message=message, step=step)

    def step_status(
        self,
        key: str,
        *,
        title: str | None = None,
        status: str = "running",
        detail: str | None = None,
        progress: float | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"key": key, "status": status}
        if title:
            payload["title"] = title
        if detail:
            payload["detail"] = detail
        if progress is not None:
            payload["progress"] = progress
        if metrics:
            payload["metrics"] = metrics
        if status == "running":
            payload["startedAt"] = int(time.time() * 1000)
        if status in ("done", "failed", "skipped"):
            payload["finishedAt"] = int(time.time() * 1000)
            if progress is None:
                payload["progress"] = 100 if status == "done" else 0
        self.emit("step.status", step=key, data=payload)

    # ------------------------------------------------------------------
    async def subscribe(self, since: int = 0):
        # Register before replaying so events emitted in between are never lost.
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._subscribers.append(queue)
        try:
            for event in list(self.events):
                if event["seq"] > since:
                    since = event["seq"]
                    yield event
            if self.closed:
                yield None
                return
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield "heartbeat"
                    continue
                if event is None:
                    break
                if event["seq"] <= since:
                    continue
                since = event["seq"]
                yield event
                if event["type"] in ("run.done", "run.error"):
                    break
        finally:
            try:
                self._subscribers.remove(queue)
            except ValueError:
                pass

    def close(self) -> None:
        self.closed = True
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(None)
            except Exception:
                pass


class EventHub:
    def __init__(self, runs_dir: Path) -> None:
        self.runs_dir = runs_dir
        self.channels: dict[str, RunChannel] = {}

    def create(self, run_id: str) -> RunChannel:
        path = self.runs_dir / f"{run_id}.events.jsonl"
        channel = RunChannel(run_id, path)
        channel.bind_loop()
        self.channels[run_id] = channel
        return channel

    def get(self, run_id: str) -> RunChannel | None:
        if run_id in self.channels:
            return self.channels[run_id]
        path = self.runs_dir / f"{run_id}.events.jsonl"
        if not path.exists():
            return None
        channel = RunChannel(run_id, path)
        try:
            with path.open("rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 900_000))
                content = fh.read().decode("utf-8", "ignore")
            for line in content.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                channel.events.append(event)
                channel._seq = max(channel._seq, int(event.get("seq", 0)))
        except Exception:
            pass
        self.channels[run_id] = channel
        return channel

    def all_events(self, since: int = 0) -> Iterable[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        for channel in self.channels.values():
            merged.extend(e for e in channel.events if e["seq"] > since)
        merged.sort(key=lambda e: (e["ts"], e["seq"]))
        return merged
