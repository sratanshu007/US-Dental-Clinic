"""Function-calling tools the LLM can use, wired to the Node API."""

import asyncio
from typing import Any, Awaitable, Callable

from loguru import logger
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import EndWorkerFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import FunctionCallParams

import api_client

check_availability = FunctionSchema(
    name="check_availability",
    description="Find open appointment times. Call with no date to get the next available times, or with a date (YYYY-MM-DD) for that day.",
    properties={
        "date": {"type": "string", "description": "Day in YYYY-MM-DD (clinic local). Omit for the soonest openings."},
        "partOfDay": {"type": "string", "enum": ["morning", "afternoon", "evening", "any"], "description": "Caller's preference."},
        "serviceId": {"type": "string", "description": "serviceId from the services list, if known."},
        "providerId": {"type": "string", "description": "providerId if the caller asked for a specific dentist."},
    },
    required=[],
)

book_appointment = FunctionSchema(
    name="book_appointment",
    description="Book an appointment after the caller clearly confirmed the day and time.",
    properties={
        "startAt": {"type": "string", "description": "Exact startAt value returned by check_availability."},
        "firstName": {"type": "string"},
        "lastName": {"type": "string"},
        "serviceId": {"type": "string"},
        "providerId": {"type": "string"},
        "reason": {"type": "string", "description": "Reason for visit in a few words, e.g. 'cleaning', 'tooth pain'."},
        "smsConsent": {"type": "boolean", "description": "True if the caller agreed to text reminders."},
        "callbackPhone": {"type": "string", "description": "Only if caller ID is unavailable: their 10 digit phone number."},
    },
    required=["startAt", "firstName"],
)

find_my_appointments = FunctionSchema(
    name="find_my_appointments",
    description="Look up the caller's upcoming appointments. Requires the first name the caller gave you (identity check).",
    properties={"firstName": {"type": "string", "description": "First name the caller just told you."}},
    required=["firstName"],
)

reschedule_appointment = FunctionSchema(
    name="reschedule_appointment",
    description="Move one of the caller's appointments (from find_my_appointments) to a new time from check_availability.",
    properties={"appointmentId": {"type": "string"}, "newStartAt": {"type": "string"}},
    required=["appointmentId", "newStartAt"],
)

cancel_appointment = FunctionSchema(
    name="cancel_appointment",
    description="Cancel one of the caller's appointments after they confirmed. Offer to reschedule first.",
    properties={"appointmentId": {"type": "string"}},
    required=["appointmentId"],
)

confirm_appointment = FunctionSchema(
    name="confirm_appointment",
    description="Mark the caller's appointment as confirmed when they say they will be there.",
    properties={"appointmentId": {"type": "string"}},
    required=["appointmentId"],
)

save_inquiry = FunctionSchema(
    name="save_inquiry",
    description="Save a sales inquiry or callback request so the clinic team follows up.",
    properties={
        "name": {"type": "string", "description": "Caller's name."},
        "interest": {"type": "string", "description": "What they want, briefly, e.g. 'Invisalign price', 'accepts Cigna?', 'call back about bill'."},
        "callbackPhone": {"type": "string", "description": "Only if different from the number they are calling from."},
    },
    required=["interest"],
)

save_feedback = FunctionSchema(
    name="save_feedback",
    description="Save the patient's rating (1-5) and comment about their visit.",
    properties={"rating": {"type": "integer", "minimum": 1, "maximum": 5}, "comment": {"type": "string"}},
    required=[],
)

transfer_to_staff = FunctionSchema(
    name="transfer_to_staff",
    description="Transfer the caller to a human at the clinic. Tell the caller you're transferring them first.",
    properties={"reason": {"type": "string"}},
    required=[],
)

end_call = FunctionSchema(
    name="end_call",
    description="Hang up after you have said goodbye.",
    properties={},
    required=[],
)


def tools_for(purpose: str, can_transfer: bool) -> ToolsSchema:
    common = [check_availability, book_appointment, end_call]
    if purpose == "RECEPTION":
        extra = [find_my_appointments, reschedule_appointment, cancel_appointment, confirm_appointment, save_inquiry]
        if can_transfer:
            extra.append(transfer_to_staff)
    elif purpose == "FEEDBACK":
        extra = [save_feedback, save_inquiry]
    else:  # NO_SHOW_REBOOK
        extra = [save_inquiry]
    return ToolsSchema(standard_tools=common + extra)


def register_tools(
    llm: Any,
    call_id: str,
    on_transfer: Callable[[str], Awaitable[None]],
) -> None:
    """Register handlers. API tools proxy to the Node API; transfer/end act on the call."""

    def api_tool(name: str):
        async def handler(params: FunctionCallParams):
            result = await api_client.tool(name, call_id, dict(params.arguments or {}))
            logger.info(f"tool {name} -> ok={result.get('ok', True)}")
            await params.result_callback(result)

        return handler

    for name in [
        "check_availability", "book_appointment", "find_my_appointments", "reschedule_appointment",
        "cancel_appointment", "confirm_appointment", "save_inquiry", "save_feedback",
    ]:
        llm.register_function(name, api_tool(name))

    async def transfer(params: FunctionCallParams):
        result = await api_client.tool("transfer_requested", call_id, dict(params.arguments or {}))
        number = result.get("transferNumber")
        if not number:
            await params.result_callback({"ok": False, "error": "Transfer not available. Use save_inquiry for a callback."})
            return
        await params.result_callback({"ok": True, "message": "Transferring now. Say nothing more."})
        # Give the AI a moment to finish its sentence, then hand the call to Plivo.
        await asyncio.sleep(2.5)
        await on_transfer(number)

    async def end(params: FunctionCallParams):
        await params.result_callback({"ok": True})
        # Ends after any queued speech (the goodbye) has been played.
        await params.llm.push_frame(EndWorkerFrame(), FrameDirection.UPSTREAM)

    llm.register_function("transfer_to_staff", transfer)
    llm.register_function("end_call", end)
