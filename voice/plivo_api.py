"""Plivo REST helpers: outbound calls, live transfer, webhook signature check."""

from typing import Any
from xml.sax.saxutils import escape

import httpx
from plivo.utils import validate_v3_signature

import config

_BASE = f"https://api.plivo.com/v1/Account/{config.PLIVO_AUTH_ID}"
_auth = (config.PLIVO_AUTH_ID, config.PLIVO_AUTH_TOKEN)


async def make_call(to_number: str, from_number: str, answer_url: str, hangup_url: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{_BASE}/Call/",
            auth=_auth,
            json={
                "to": to_number,
                "from": from_number,
                "answer_url": answer_url,
                "answer_method": "GET",
                "hangup_url": hangup_url,
                "hangup_method": "POST",
                "ring_timeout": 30,
                # Answering-machine detection: Plivo tells us if a machine picked up
                "machine_detection": "true",
            },
        )
        r.raise_for_status()
        return r.json()


async def transfer_call(call_uuid: str, xml_url: str) -> None:
    """Point the live call (A leg) at new XML that dials the clinic staff line."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{_BASE}/Call/{call_uuid}/",
            auth=_auth,
            json={"legs": "aleg", "aleg_url": xml_url, "aleg_method": "GET"},
        )
        r.raise_for_status()


def stream_xml(ws_url: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">{escape(ws_url)}</Stream>
</Response>"""


def dial_xml(number: str, caller_id: str | None = None) -> str:
    cid = f' callerId="{escape(caller_id)}"' if caller_id else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial{cid}><Number>{escape(number)}</Number></Dial>
</Response>"""


def hangup_xml(message: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="WOMAN" language="en-US">{escape(message)}</Speak>
  <Hangup/>
</Response>"""


def signature_ok(method: str, url: str, headers: dict[str, str], params: dict[str, Any]) -> bool:
    if not config.VERIFY_PLIVO_SIGNATURE:
        return True
    sig = headers.get("x-plivo-signature-v3")
    nonce = headers.get("x-plivo-signature-v3-nonce")
    if not sig or not nonce or not config.PLIVO_AUTH_TOKEN:
        return False
    try:
        return bool(validate_v3_signature(method, url, nonce, config.PLIVO_AUTH_TOKEN, sig, params))
    except Exception:
        return False
