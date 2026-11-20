"""Multi-model fallback LLM service for Pipecat with Groq and OpenAI support.

If the primary model fails (e.g. rate limit 429, timeout, server error 500, or quota),
it automatically fails over to the next configured model in the chain so calls are never dropped.
"""

from dataclasses import dataclass
from typing import Any
import httpx
from loguru import logger
from openai import AsyncOpenAI
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.llm import OpenAILLMService

import config


@dataclass
class LLMCandidate:
    name: str
    provider: str  # "groq" or "openai"
    model: str
    client: AsyncOpenAI
    base_url: str


def build_llm_candidates() -> list[LLMCandidate]:
    """Builds ordered list of LLM candidates from environment settings."""
    candidates: list[LLMCandidate] = []

    # 1. Groq candidates (Free, fast LPU inference)
    groq_key = config.GROQ_API_KEY or "none"
    groq_client = AsyncOpenAI(
        api_key=groq_key,
        base_url="https://api.groq.com/openai/v1",
    )
    for model_name in config.GROQ_MODELS:
        candidates.append(
            LLMCandidate(
                name=f"groq/{model_name}",
                provider="groq",
                model=model_name,
                client=groq_client,
                base_url="https://api.groq.com/openai/v1",
            )
        )

    # 2. OpenAI candidates (if key configured)
    if config.OPENAI_API_KEY:
        openai_client = AsyncOpenAI(
            api_key=config.OPENAI_API_KEY,
            base_url=config.OPENAI_BASE_URL or "https://api.openai.com/v1",
        )
        candidates.append(
            LLMCandidate(
                name=f"openai/{config.OPENAI_MODEL}",
                provider="openai",
                model=config.OPENAI_MODEL,
                client=openai_client,
                base_url=config.OPENAI_BASE_URL or "https://api.openai.com/v1",
            )
        )

    # If user explicitly preferred OpenAI as primary provider, put OpenAI first
    if config.LLM_PROVIDER == "openai" and config.OPENAI_API_KEY:
        candidates.sort(key=lambda c: 0 if c.provider == "openai" else 1)

    if not candidates:
        # Fallback dummy to allow initialization
        dummy_client = AsyncOpenAI(api_key="none", base_url="https://api.groq.com/openai/v1")
        candidates.append(
            LLMCandidate(
                name="groq/llama-3.3-70b-versatile",
                provider="groq",
                model="llama-3.3-70b-versatile",
                client=dummy_client,
                base_url="https://api.groq.com/openai/v1",
            )
        )

    return candidates


class FallbackLLMService(OpenAILLMService):
    """OpenAILLMService with seamless model cascading across Groq and OpenAI."""

    def __init__(
        self,
        candidates: list[LLMCandidate],
        settings: OpenAILLMService.Settings,
        **kwargs,
    ):
        self.candidates = candidates
        self.active_index = 0
        primary = candidates[0]

        super().__init__(
            api_key=config.GROQ_API_KEY or config.OPENAI_API_KEY or "none",
            base_url=primary.base_url,
            settings=settings,
            **kwargs,
        )
        # Groq expects standard roles (user/system) rather than 'developer'
        self.supports_developer_role = False
        logger.info(
            f"Initialized FallbackLLMService with {len(candidates)} models: "
            f"{[c.name for c in candidates]}. Primary: {primary.name}"
        )

    async def get_chat_completions(self, context: LLMContext):
        """Attempts chat completion with the active model; cascades to next model on failure."""
        adapter = self.get_llm_adapter()
        self._log_llm_response(context)

        params_from_context = await adapter.get_llm_invocation_params(
            context,
            system_instruction=self._settings.system_instruction,
            convert_developer_to_user=True,
        )

        base_params = self.build_chat_completion_params(params_from_context)

        total_candidates = len(self.candidates)
        last_error: Exception | None = None

        for attempt in range(total_candidates):
            idx = (self.active_index + attempt) % total_candidates
            cand = self.candidates[idx]
            cand_params = dict(base_params)
            cand_params["model"] = cand.model

            # Clean parameters not supported by Groq or certain providers
            if cand.provider == "groq":
                cand_params.pop("reasoning_effort", None)
                cand_params.pop("service_tier", None)

            try:
                stream = await cand.client.chat.completions.create(**cand_params)
                if idx != self.active_index:
                    logger.warning(
                        f"LLM failover successful: active model changed from "
                        f"'{self.candidates[self.active_index].name}' to '{cand.name}'"
                    )
                    self.active_index = idx
                return stream
            except Exception as e:
                last_error = e
                logger.warning(
                    f"LLM model '{cand.name}' ({cand.model}) failed ({type(e).__name__}: {e}). "
                    f"Trying next fallback model in chain..."
                )
                continue

        logger.error("All configured LLM models in fallback chain failed!")
        if last_error:
            raise last_error
        raise RuntimeError("No LLM models available.")


async def summarize_transcript(transcript: str) -> str | None:
    """Summarize dental call transcript using Groq / OpenAI with automatic fallback."""
    if not transcript.strip():
        return None

    prompt = (
        "Summarize this dental clinic phone call for the front desk in at most two short sentences: "
        "who called, what they wanted, and what was done or still needs follow-up. No extra health details."
    )

    candidates = build_llm_candidates()
    for cand in candidates:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                api_key = config.GROQ_API_KEY if cand.provider == "groq" else config.OPENAI_API_KEY
                if not api_key:
                    continue

                headers = {"Authorization": f"Bearer {api_key}"}
                payload = {
                    "model": cand.model,
                    "messages": [
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": transcript[:12000]},
                    ],
                    "max_tokens": 120,
                    "temperature": 0.2,
                }
                r = await client.post(
                    f"{cand.base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                )
                if r.status_code == 200:
                    summary = r.json()["choices"][0]["message"]["content"].strip()
                    logger.info(f"Generated call summary using {cand.name}")
                    return summary
                else:
                    logger.warning(f"Summary request to {cand.name} returned status {r.status_code}")
        except Exception as e:
            logger.warning(f"Summary with {cand.name} failed: {type(e).__name__}. Trying next...")
            continue

    return None
