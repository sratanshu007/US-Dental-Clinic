"""FastAPI server for the voice agent.

Plivo setup (per clinic number): create a Plivo Application with
  Answer URL  = {PUBLIC_URL}/plivo/answer   (POST)
  Hangup URL  = {PUBLIC_URL}/plivo/hangup   (POST)
and attach the clinic's phone number to it.

Run one process (calls are tracked in memory between the answer webhook and the
media WebSocket). Scale by running more instances behind sticky routing per call.
"""

import os
import sys
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from loguru import logger
from pipecat.runner.utils import parse_telephony_websocket

import api_client
import config
import plivo_api
from bot import TRANSFER_TARGETS, run_call

# HIPAA: DEBUG logs from the speech pipeline include what callers say. Keep INFO in production.
logger.remove()
logger.add(sys.stderr, level=os.getenv("LOG_LEVEL", "INFO"))

app = FastAPI(title="Dental AI Receptionist — Voice Agent", docs_url=None, redoc_url=None)

# CallUUID -> call info, filled by the answer webhook, read when the media stream connects.
PENDING: dict[str, dict[str, Any]] = {}
# taskId -> True once the AI actually talked to someone (for no-answer detection)
CONNECTED_TASKS: set[str] = set()


def _ws_url(call_uuid: str) -> str:
    base = config.PUBLIC_URL.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/ws?call={call_uuid}"


def _gc() -> None:
    cutoff = time.time() - 600
    for k in [k for k, v in PENDING.items() if v["at"] < cutoff]:
        PENDING.pop(k, None)
    for k in [k for k, v in TRANSFER_TARGETS.items() if float(v.get("at", time.time())) < cutoff]:
        TRANSFER_TARGETS.pop(k, None)


async def _params(request: Request) -> dict[str, Any]:
    params: dict[str, Any] = dict(request.query_params)
    if request.method == "POST":
        form = await request.form()
        params.update({k: str(v) for k, v in form.items()})
    return params


def _check_signature(request: Request, params: dict[str, Any]) -> None:
    url = f"{config.PUBLIC_URL}{request.url.path}"
    if request.url.query:
        url += f"?{request.url.query}"
    post_params = {k: v for k, v in params.items() if k not in request.query_params} if request.method == "POST" else {}
    if not plivo_api.signature_ok(request.method, url, {k.lower(): v for k, v in request.headers.items()}, post_params):
        raise HTTPException(status_code=401, detail="Bad signature")


@app.api_route("/plivo/answer", methods=["GET", "POST"])
async def inbound_answer(request: Request):
    """Patient calls the clinic number -> stream the call audio to our WebSocket."""
    p = await _params(request)
    _check_signature(request, p)
    _gc()
    call_uuid, from_n, to_n = p.get("CallUUID"), p.get("From", ""), p.get("To", "")
    if not call_uuid:
        raise HTTPException(400, "Missing CallUUID")
    PENDING[call_uuid] = {"direction": "INBOUND", "from": from_n, "to": to_n, "at": time.time()}
    logger.info(f"inbound call {call_uuid}")
    return Response(plivo_api.stream_xml(_ws_url(call_uuid)), media_type="application/xml")


@app.api_route("/plivo/outbound-answer", methods=["GET", "POST"])
async def outbound_answer(request: Request):
    """Patient picked up our outbound call."""
    p = await _params(request)
    _check_signature(request, p)
    _gc()
    call_uuid, task_id = p.get("CallUUID"), p.get("task")
    if not call_uuid or not task_id:
        raise HTTPException(400, "Missing CallUUID/task")
    PENDING[call_uuid] = {"direction": "OUTBOUND", "from": p.get("From", ""), "to": p.get("To", ""), "taskId": task_id, "at": time.time()}
    return Response(plivo_api.stream_xml(_ws_url(call_uuid)), media_type="application/xml")


@app.post("/plivo/hangup")
async def hangup(request: Request):
    """Call ended. For outbound calls nobody answered, tell the API so it can retry or give up."""
    p = await _params(request)
    _check_signature(request, p)
    task_id = p.get("task")
    if task_id and task_id not in CONNECTED_TASKS:
        status = p.get("CallStatus", "")
        await api_client.task_result(task_id, "NO_ANSWER" if status in ("no-answer", "busy", "timeout", "cancel", "completed") else "FAILED", status or None)
    CONNECTED_TASKS.discard(task_id or "")
    return Response("ok")


@app.get("/plivo/transfer-xml")
async def transfer_xml(t: str):
    target = TRANSFER_TARGETS.pop(t, None)
    if not target:
        return Response(plivo_api.hangup_xml("Sorry, we could not connect you. Please call back."), media_type="application/xml")
    return Response(plivo_api.dial_xml(target["number"], target.get("callerId")), media_type="application/xml")


@app.post("/outbound/start")
async def outbound_start(request: Request):
    """Called by the Node API job runner to place a no-show or feedback call."""
    if request.headers.get("x-internal-key") != config.INTERNAL_API_KEY:
        raise HTTPException(401, "Invalid internal key")
    body = await request.json()
    task_id, to_n, from_n = body.get("taskId"), body.get("to"), body.get("from")
    if not (task_id and to_n and from_n):
        raise HTTPException(400, "taskId, to and from are required")
    try:
        r = await plivo_api.make_call(
            to_n,
            from_n,
            answer_url=f"{config.PUBLIC_URL}/plivo/outbound-answer?task={task_id}",
            hangup_url=f"{config.PUBLIC_URL}/plivo/hangup?task={task_id}",
        )
    except Exception as e:
        logger.error(f"outbound call failed for task {task_id}: {type(e).__name__}")
        await api_client.task_result(task_id, "FAILED", "plivo call failed")
        raise HTTPException(502, "Plivo call failed")
    return JSONResponse({"ok": True, "requestUuid": r.get("request_uuid")})


@app.websocket("/ws")
async def media_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        transport_type, call_data = await parse_telephony_websocket(websocket)
    except Exception:
        await websocket.close()
        return
    if transport_type != "plivo":
        await websocket.close()
        return
    call_uuid = call_data["call_id"]
    info = PENDING.pop(call_uuid, None) or PENDING.pop(websocket.query_params.get("call", ""), None)
    if not info:
        logger.warning("media stream for unknown call — rejecting")
        await websocket.close()
        return
    if info.get("taskId"):
        CONNECTED_TASKS.add(info["taskId"])
    await run_call(websocket, call_data["stream_id"], call_uuid, info)


@app.get("/health")
async def health():
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "7860")))
