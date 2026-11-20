"""Contract test: the voice agent's tool calls work against a running Node API.
Run with the API on :4000 (seeded):  INTERNAL_API_KEY=dev-internal-key python -m tests.test_contract
"""
import asyncio
import random

import api_client
from prompts import build_prompt
from tools import tools_for


async def main():
    caller = f"+1210558{random.randint(1000, 9999)}"
    s = await api_client.start_call("INBOUND", caller, "+12105550100", "test-call")
    assert s["purpose"] == "RECEPTION"
    prompt = build_prompt(s)
    assert "Demo Family Dental" in prompt and "serviceId=" in prompt
    assert len(tools_for("RECEPTION", True).standard_tools) == 9

    avail = await api_client.tool("check_availability", s["callId"], {"partOfDay": "afternoon", "date": None})
    assert avail["slots"], avail
    slot = avail["slots"][0]
    booked = await api_client.tool("book_appointment", s["callId"], {"startAt": slot["startAt"], "firstName": "Lena", "smsConsent": False})
    assert booked["ok"], booked
    mine = await api_client.tool("find_my_appointments", s["callId"], {"firstName": "Lena"})
    assert mine["appointments"][0]["appointmentId"] == booked["appointmentId"]
    bad = await api_client.tool("cancel_appointment", s["callId"], {"appointmentId": "does-not-exist"})
    assert bad["ok"] is False
    await api_client.end_call(s["callId"], "Caller: hi\nAI: hello", "Booked Lena", 42)
    print("contract test passed:", slot["when"])


asyncio.run(main())
