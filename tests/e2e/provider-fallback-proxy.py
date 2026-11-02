"""Deterministic mitmproxy fixture for installed-TUI provider fallback acceptance."""

import json
import os
from pathlib import Path
from typing import Any

from mitmproxy import http

CONTROL = Path(os.environ["FLYWHEEL_FALLBACK_CONTROL"])
EVIDENCE = Path(os.environ["FLYWHEEL_FALLBACK_EVIDENCE"])
TARGET_HOSTS = {"api.openai.com", "openrouter.ai", "models.dev"}


def scenario() -> str:
    return json.loads(CONTROL.read_text(encoding="utf-8"))["scenario"]


def request_json(flow: http.HTTPFlow) -> dict[str, Any]:
    try:
        value = json.loads(flow.request.get_text(strict=False))
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


def record(kind: str, flow: http.HTTPFlow, **details: Any) -> None:
    entry = {
        "kind": kind,
        "scenario": scenario(),
        "method": flow.request.method,
        "host": flow.request.host,
        "path": flow.request.path,
        **details,
    }
    with EVIDENCE.open("a", encoding="utf-8") as output:
        output.write(json.dumps(entry, sort_keys=True) + "\n")


def json_response(status: int, payload: object) -> http.Response:
    return http.Response.make(status, json.dumps(payload), {"content-type": "application/json"})


def sse_response(events: list[object]) -> http.Response:
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    return http.Response.make(200, body, {"content-type": "text/event-stream", "cache-control": "no-cache"})


def model_row(model_id: str) -> dict[str, object]:
    return {"id": model_id, "name": model_id, "reasoning": True, "tool_call": True, "limit": {"context": 128000, "output": 4096}, "cost": {"input": 1, "output": 2}}


def models_document() -> dict[str, object]:
    providers = {f"fixture-{index}": {"name": f"Fixture {index}", "models": {"fixture": model_row("fixture")}} for index in range(8)}
    providers["openai"] = {"name": "OpenAI", "models": {"gpt-5.4": model_row("gpt-5.4")}}
    providers["openrouter"] = {"name": "OpenRouter", "models": {"openai/gpt-5.4": model_row("openai/gpt-5.4")}}
    return providers


class ProviderFallbackFixture:
    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.host
        path = flow.request.path.split("?", 1)[0]
        if host == "models.dev" and path == "/api.json":
            record("catalog", flow)
            flow.response = json_response(200, models_document())
            return
        if host == "api.openai.com" and path == "/v1/models":
            record("catalog", flow)
            flow.response = json_response(200, {"data": [model_row("gpt-5.4")]})
            return
        if host == "openrouter.ai" and path == "/api/v1/models":
            record("catalog", flow)
            flow.response = json_response(200, {"data": [model_row("openai/gpt-5.4")]})
            return
        if host == "api.openai.com" and path == "/v1/responses":
            self.openai_response(flow)
            return
        if host == "openrouter.ai" and path == "/api/v1/chat/completions":
            self.openrouter_response(flow)
            return
        record("blocked-outbound", flow)
        flow.response = json_response(502, {"error": {"message": "unexpected outbound request blocked by provider fallback fixture"}})

    def openai_response(self, flow: http.HTTPFlow) -> None:
        body = request_json(flow)
        current = scenario()
        record("attempt", flow, provider="openai_api", endpoint="responses", model=body.get("model"))
        if current == "quota":
            flow.response = json_response(429, {"error": {"type": "insufficient_quota", "code": "insufficient_quota", "message": "fixture quota exhausted"}})
            return
        if current == "unknown":
            flow.response = json_response(503, {"error": {"type": "fixture_unknown", "code": "fixture_unknown", "message": "fixture unknown provider failure"}})
            return
        if current != "partial-tool":
            flow.response = json_response(500, {"error": {"message": "unknown fixture scenario"}})
            return
        call = {"type": "function_call", "id": "fc_fixture_read", "call_id": "call_fixture_read", "name": "read", "arguments": '{"path":"fixture.txt"}'}
        events = [
            {"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress"}},
            {"type": "response.output_item.added", "output_index": 0, "item": {"type": "message", "id": "msg_fixture", "role": "assistant", "content": [], "status": "in_progress"}},
            {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "PARTIAL-FALLBACK-TEXT "},
            {"type": "response.output_item.done", "output_index": 1, "item": call},
            {"type": "response.failed", "response": {"id": "resp_fixture", "status": "failed", "output": [call], "error": {"code": "server_error", "message": "fixture failed after tool"}}},
        ]
        flow.response = sse_response(events)

    def openrouter_response(self, flow: http.HTTPFlow) -> None:
        body = request_json(flow)
        serialized = json.dumps(body, sort_keys=True)
        has_tool_result = '"role": "tool"' in serialized or "function_call_output" in serialized
        mentions_fixture = "fixture-read-result" in serialized
        record(
            "attempt",
            flow,
            provider="openrouter",
            endpoint="chat_completions",
            model=body.get("model"),
            has_tool_result=has_tool_result,
            mentions_fixture_result=mentions_fixture,
        )
        current = scenario()
        answer = "FALLBACK-SUCCESS" if current != "partial-tool" else "FINAL-AFTER-RECORDED-READ"
        chunk_id = f"chatcmpl-{current}"
        events = [
            {"id": chunk_id, "object": "chat.completion.chunk", "created": 1, "model": "openai/gpt-5.4", "choices": [{"index": 0, "delta": {"role": "assistant", "content": answer}, "finish_reason": None}]},
            {"id": chunk_id, "object": "chat.completion.chunk", "created": 1, "model": "openai/gpt-5.4", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 17, "completion_tokens": 5, "total_tokens": 22}},
        ]
        flow.response = sse_response(events)


addons = [ProviderFallbackFixture()]
