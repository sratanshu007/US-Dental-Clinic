"""Multi-provider TTS fallback service for Pipecat.

Supports:
- edge: Free Microsoft Edge TTS (no API key needed, high quality neural voices)
- elevenlabs: Ultra-realistic ElevenLabs voices
- deepgram: Deepgram Aura TTS
- cartesia: Cartesia Sonic TTS

Features automatic cascading fallback: if a provider fails (quota limit, rate limit,
network error, or invalid key), it immediately switches to the next configured provider
without dropping audio or disconnecting the call.
"""

import io
import asyncio
from typing import AsyncGenerator
import edge_tts
import httpx
from loguru import logger
import soundfile as sf
from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TTSService, TTSSettings

import config


class FallbackTTSService(TTSService):
    """Pipecat TTSService that seamlessly cascades across multiple TTS providers."""

    Settings = TTSSettings

    def __init__(
        self,
        primary_provider: str | None = None,
        fallback_providers: list[str] | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.primary_provider = (primary_provider or config.TTS_PROVIDER).lower()
        self.fallback_providers = [
            p.lower() for p in (fallback_providers or config.TTS_FALLBACK_PROVIDERS)
        ]

        # Combine into ordered list of providers
        chain: list[str] = [self.primary_provider]
        for p in self.fallback_providers:
            if p not in chain:
                chain.append(p)
        self.providers = chain
        self.active_provider = chain[0]
        self._sample_rate = 24000

        logger.info(
            f"Initialized FallbackTTSService with chain: {self.providers}. "
            f"Active primary: {self.active_provider}"
        )

    # ---------------- Edge TTS (Free Microsoft Neural Voices) ----------------
    async def _synth_edge(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        voice = config.EDGE_TTS_VOICE or "en-US-JennyNeural"
        comm = edge_tts.Communicate(text, voice)
        audio = bytearray()
        async for chunk in comm.stream():
            if chunk.get("type") == "audio":
                audio.extend(chunk.get("data", b""))
        if not audio:
            raise RuntimeError("Edge TTS returned empty audio stream")

        # Decode MP3 into 24kHz 16-bit PCM
        data, sr = sf.read(io.BytesIO(audio), dtype="int16")
        pcm = data.tobytes()

        # Emit in ~100ms chunks for smooth transport delivery
        chunk_bytes = int(sr * 2 * 0.1)
        for i in range(0, len(pcm), chunk_bytes):
            yield TTSAudioRawFrame(
                pcm[i : i + chunk_bytes],
                sr,
                1,
                context_id=context_id,
            )

    # ---------------- ElevenLabs TTS ----------------
    async def _synth_elevenlabs(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not config.ELEVENLABS_API_KEY:
            raise ValueError("ELEVENLABS_API_KEY is not configured")

        voice_id = config.ELEVENLABS_VOICE_ID or "21m00Tcm4TlvDq8ikWAM"
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_24000"
        headers = {
            "xi-api-key": config.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
        }
        payload = {
            "text": text,
            "model_id": config.ELEVENLABS_MODEL or "eleven_turbo_v2_5",
        }

        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"ElevenLabs error {resp.status_code}: {resp.text[:150]}")
            pcm = resp.content
            sr = 24000
            chunk_bytes = int(sr * 2 * 0.1)
            for i in range(0, len(pcm), chunk_bytes):
                yield TTSAudioRawFrame(
                    pcm[i : i + chunk_bytes],
                    sr,
                    1,
                    context_id=context_id,
                )

    # ---------------- Deepgram Aura TTS ----------------
    async def _synth_deepgram(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not config.DEEPGRAM_API_KEY:
            raise ValueError("DEEPGRAM_API_KEY is not configured")

        voice = config.DEEPGRAM_VOICE or "aura-2-thalia-en"
        url = f"https://api.deepgram.com/v1/speak?model={voice}&encoding=linear16&sample_rate=24000"
        headers = {
            "Authorization": f"Token {config.DEEPGRAM_API_KEY}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, headers=headers, json={"text": text})
            if resp.status_code != 200:
                raise RuntimeError(f"Deepgram TTS error {resp.status_code}: {resp.text[:150]}")
            pcm = resp.content
            sr = 24000
            chunk_bytes = int(sr * 2 * 0.1)
            for i in range(0, len(pcm), chunk_bytes):
                yield TTSAudioRawFrame(
                    pcm[i : i + chunk_bytes],
                    sr,
                    1,
                    context_id=context_id,
                )

    # ---------------- Cartesia Sonic TTS ----------------
    async def _synth_cartesia(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not config.CARTESIA_API_KEY or not config.CARTESIA_VOICE_ID:
            raise ValueError("CARTESIA_API_KEY or CARTESIA_VOICE_ID is not configured")

        url = "https://api.cartesia.ai/tts/bytes"
        headers = {
            "X-API-Key": config.CARTESIA_API_KEY,
            "Cartesia-Version": "2024-06-10",
            "Content-Type": "application/json",
        }
        payload = {
            "model_id": "sonic-english",
            "transcript": text,
            "voice": {"mode": "id", "id": config.CARTESIA_VOICE_ID},
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": 24000,
            },
        }

        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"Cartesia error {resp.status_code}: {resp.text[:150]}")
            pcm = resp.content
            sr = 24000
            chunk_bytes = int(sr * 2 * 0.1)
            for i in range(0, len(pcm), chunk_bytes):
                yield TTSAudioRawFrame(
                    pcm[i : i + chunk_bytes],
                    sr,
                    1,
                    context_id=context_id,
                )

    # ---------------- Main TTS Execution with Cascading Fallback ----------------
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        if not text.strip():
            return

        await self.start_tts_usage_metrics(text)

        # Order providers starting with active, then other fallbacks
        ordered = [self.active_provider] + [p for p in self.providers if p != self.active_provider]
        last_error: Exception | None = None

        for provider in ordered:
            try:
                frames_yielded = 0
                if provider == "edge":
                    async for frame in self._synth_edge(text, context_id):
                        if frames_yielded == 0:
                            await self.stop_ttfb_metrics()
                        frames_yielded += 1
                        yield frame
                elif provider == "elevenlabs":
                    async for frame in self._synth_elevenlabs(text, context_id):
                        if frames_yielded == 0:
                            await self.stop_ttfb_metrics()
                        frames_yielded += 1
                        yield frame
                elif provider == "deepgram":
                    async for frame in self._synth_deepgram(text, context_id):
                        if frames_yielded == 0:
                            await self.stop_ttfb_metrics()
                        frames_yielded += 1
                        yield frame
                elif provider == "cartesia":
                    async for frame in self._synth_cartesia(text, context_id):
                        if frames_yielded == 0:
                            await self.stop_ttfb_metrics()
                        frames_yielded += 1
                        yield frame
                else:
                    logger.warning(f"Unknown TTS provider: {provider}")
                    continue

                if frames_yielded > 0:
                    if provider != self.active_provider:
                        logger.warning(
                            f"TTS failover successful: active provider switched from "
                            f"'{self.active_provider}' to '{provider}'"
                        )
                        self.active_provider = provider
                    return
            except Exception as e:
                last_error = e
                logger.warning(
                    f"TTS provider '{provider}' failed ({type(e).__name__}: {e}). "
                    f"Cascading to next fallback provider..."
                )
                continue

        logger.error(f"All configured TTS providers failed to synthesize: {text[:40]}...")
        if last_error:
            raise last_error
        raise RuntimeError("No TTS providers available.")


def make_tts() -> TTSService:
    """Factory creating the configured FallbackTTSService."""
    return FallbackTTSService()
