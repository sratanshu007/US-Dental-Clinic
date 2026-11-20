"""Small async client for the Node API's /internal endpoints."""

from typing import Any

import httpx

import config

_client = httpx.AsyncClient(
    base_url=config.API_URL,
    headers={"X-Internal-Key": config.INTERNAL_API_KEY},
    timeout=httpx.Timeout(10.0, connect=5.0),
)


async def start_call(direction: str, from_number: str, to_number: str, call_uuid: str | None, task_id: str | None = None) -> dict[str, Any]:
    r = await _client.post(
        "/internal/calls/start",
        json={"direction": direction, "from": from_number, "to": to_number, "plivoCallUuid": call_uuid, "taskId": task_id},
    )
    r.raise_for_status()
    return r.json()


async def tool(name: str, call_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run an AI tool on the API. Errors come back as {"ok": False, "error": ...} so the AI can recover."""
    args = {k: v for k, v in args.items() if v is not None and v != ""}
    try:
        r = await _client.post(f"/internal/tools/{name}", json={"callId": call_id, "args": args})
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", "Request failed")
            except Exception:
                msg = "Request failed"
            return {"ok": False, "error": msg}
        return r.json()
    except httpx.HTTPError:
        return {"ok": False, "error": "The scheduling system is not responding. Offer to have the front desk call back."}


async def end_call(call_id: str, transcript: str, summary: str | None, duration_sec: int) -> None:
    try:
        await _client.post(
            f"/internal/calls/{call_id}/end",
            json={"transcript": transcript, "summary": summary, "durationSec": duration_sec},
        )
    except httpx.HTTPError:
        pass


async def task_result(task_id: str, status: str, error: str | None = None) -> None:
    try:
        await _client.post(f"/internal/tasks/{task_id}/result", json={"status": status, "error": error})
    except httpx.HTTPError:
        pass
