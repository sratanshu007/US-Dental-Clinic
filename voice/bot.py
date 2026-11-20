"""One phone call = one Pipecat pipeline: Plivo audio -> Deepgram STT -> Fallback LLM (Groq/OpenAI) -> Fallback TTS (Edge/ElevenLabs/Deepgram) -> Plivo."""

import time
import uuid
from typing import Any

from fastapi import WebSocket
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import EndWorkerFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.serializers.plivo import PlivoFrameSerializer
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

import api_client
import config
from llm_fallback import FallbackLLMService, build_llm_candidates, summarize_transcript
from tts_fallback import make_tts
import plivo_api
from prompts import build_prompt, first_line_instruction
from tools import register_tools, tools_for

# Short-lived map: random token -> staff number, used by /plivo/transfer-xml
TRANSFER_TARGETS: dict[str, dict[str, str]] = {}


def _transcript(context: LLMContext) -> str:
    lines = []
    for m in context.get_messages():
        role = m.get("role") if isinstance(m, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        if role not in ("user", "assistant") or not content:
            continue
        if isinstance(content, list):  # multi-part content
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        if content.strip():
            lines.append(f"{'Caller' if role == 'user' else 'AI'}: {content.strip()}")
    return "\n".join(lines)


async def _summarize(transcript: str) -> str | None:
    """Summarize call for clinic dashboard using Groq / OpenAI with automatic fallback."""
    return await summarize_transcript(transcript)


async def run_call(websocket: WebSocket, stream_id: str, call_uuid: str, info: dict[str, Any]) -> None:
    """info = {"direction": "INBOUND"|"OUTBOUND", "from": ..., "to": ..., "taskId": ...}"""
    started = time.monotonic()
    try:
        session = await api_client.start_call(info["direction"], info["from"], info["to"], call_uuid, info.get("taskId"))
    except Exception as e:
        logger.error(f"could not start call session: {type(e).__name__}")
        await websocket.close()
        return

    call_id: str = session["callId"]
    purpose: str = session["purpose"]
    logger.info(f"call {call_id} purpose={purpose} direction={info['direction']}")

    serializer = PlivoFrameSerializer(
        stream_id=stream_id,
        call_id=call_uuid,
        auth_id=config.PLIVO_AUTH_ID,
        auth_token=config.PLIVO_AUTH_TOKEN,
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
            session_timeout=config.MAX_CALL_SECONDS,
        ),
    )

    stt = DeepgramSTTService(api_key=config.DEEPGRAM_API_KEY, mip_opt_out=True)

    # Multi-model LLM with fallback (Groq primary + OpenAI fallback)
    candidates = build_llm_candidates()
    llm = FallbackLLMService(
        candidates=candidates,
        settings=OpenAILLMService.Settings(
            model=candidates[0].model,
            system_instruction=build_prompt(session),
        ),
    )

    # Multi-provider TTS with fallback (Edge TTS, ElevenLabs, Deepgram, Cartesia)
    tts = make_tts()

    context = LLMContext(tools=tools_for(purpose, bool(session["clinic"].get("transferNumber"))))
    user_agg, assistant_agg = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
    )

    pipeline = Pipeline([transport.input(), stt, user_agg, llm, tts, transport.output(), assistant_agg])
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000, enable_metrics=False),
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    async def on_transfer(number: str) -> None:
        # After Plivo moves the call to <Dial>, the media stream closes. Don't let the
        # serializer hang up the caller when our pipeline stops.
        serializer._params.auto_hang_up = False  # noqa: SLF001
        token = uuid.uuid4().hex
        TRANSFER_TARGETS[token] = {
            "number": number,
            "callerId": info["to"] if info["direction"] == "INBOUND" else info["from"],
            "at": str(time.time()),
        }
        try:
            await plivo_api.transfer_call(call_uuid, f"{config.PUBLIC_URL}/plivo/transfer-xml?t={token}")
        except Exception as e:
            logger.error(f"transfer failed: {type(e).__name__}")
            serializer._params.auto_hang_up = True  # noqa: SLF001
            return
        await worker.queue_frames([EndWorkerFrame()])

    register_tools(llm, call_id, on_transfer)

    @transport.event_handler("on_client_connected")
    async def _connected(_t, _c):
        context.add_message({"role": "developer", "content": first_line_instruction(session)})
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def _disconnected(_t, _c):
        await runner.cancel()

    @transport.event_handler("on_session_timeout")
    async def _timeout(_t, _c):
        logger.warning(f"call {call_id} hit max duration")
        await runner.cancel()

    try:
        await runner.run()
    finally:
        transcript = _transcript(context)
        summary = await _summarize(transcript)
        await api_client.end_call(call_id, transcript, summary, int(time.monotonic() - started))
        logger.info(f"call {call_id} ended")
