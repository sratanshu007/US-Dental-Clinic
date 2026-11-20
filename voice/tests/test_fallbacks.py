"""Tests for Groq/OpenAI LLM cascading fallback and EdgeTTS/ElevenLabs TTS fallback."""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from openai import AsyncOpenAI

from llm_fallback import FallbackLLMService, LLMCandidate, build_llm_candidates
from tts_fallback import FallbackTTSService
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.llm import OpenAILLMService


def test_build_llm_candidates():
    candidates = build_llm_candidates()
    assert len(candidates) >= 1
    assert any(c.provider == "groq" for c in candidates)
    print("✓ LLM candidate builder tested:", [c.name for c in candidates])


async def test_llm_fallback_execution():
    # Mock client 1 that fails with RateLimit (429)
    client1 = MagicMock(spec=AsyncOpenAI)
    client1.chat = MagicMock()
    client1.chat.completions = MagicMock()
    client1.chat.completions.create = AsyncMock(side_effect=RuntimeError("Groq 429 Rate Limit Exceeded"))

    # Mock client 2 that succeeds
    client2 = MagicMock(spec=AsyncOpenAI)
    client2.chat = MagicMock()
    client2.chat.completions = MagicMock()
    mock_stream = AsyncMock()
    client2.chat.completions.create = AsyncMock(return_value=mock_stream)

    cand1 = LLMCandidate("groq/llama-3.3-70b-versatile", "groq", "llama-3.3-70b-versatile", client1, "https://api.groq.com/openai/v1")
    cand2 = LLMCandidate("groq/llama-3.1-8b-instant", "groq", "llama-3.1-8b-instant", client2, "https://api.groq.com/openai/v1")

    service = FallbackLLMService(
        candidates=[cand1, cand2],
        settings=OpenAILLMService.Settings(
            model=cand1.model,
            system_instruction="You are a dental receptionist.",
        ),
    )

    context = LLMContext()
    context.add_message({"role": "user", "content": "What are your hours?"})

    stream = await service.get_chat_completions(context)
    assert stream is mock_stream
    assert service.active_index == 1
    print("✓ LLM automatic failover passed: Groq 70b (failed 429) -> Groq 8b (succeeded)")


async def test_tts_fallback_execution():
    # Test FallbackTTSService with failing primary (e.g. ElevenLabs with invalid key) falling back to simulated working
    service = FallbackTTSService(primary_provider="elevenlabs", fallback_providers=["edge"])
    assert service.active_provider == "elevenlabs"

    # Mock _synth_elevenlabs to simulate quota/auth error and _synth_edge to succeed
    service._synth_elevenlabs = AsyncMock(side_effect=RuntimeError("ElevenLabs quota exceeded"))
    
    mock_frame = MagicMock()
    async def mock_edge(text, context_id):
        yield mock_frame

    service._synth_edge = mock_edge

    frames = []
    async for f in service.run_tts("Welcome to our dental clinic.", "test-ctx"):
        frames.append(f)

    assert len(frames) == 1
    assert frames[0] is mock_frame
    assert service.active_provider == "edge"
    print("✓ TTS automatic failover passed: ElevenLabs (failed quota) -> Edge TTS (succeeded)")


async def main():
    test_build_llm_candidates()
    await test_llm_fallback_execution()
    await test_tts_fallback_execution()
    print("\nAll Fallback LLM and TTS tests passed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
