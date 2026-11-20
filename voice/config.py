"""Voice agent settings (from environment / .env)."""

import os
from dotenv import load_dotenv

load_dotenv()


def _req(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing required env var {name}")
    return v


# Public HTTPS URL of THIS voice service (Plivo calls it). e.g. https://voice.yourdomain.com
PUBLIC_URL = os.getenv("PUBLIC_URL", "http://localhost:7860").rstrip("/")

# Node API
API_URL = os.getenv("API_URL", "http://localhost:4000").rstrip("/")
INTERNAL_API_KEY = _req("INTERNAL_API_KEY")

# Plivo
PLIVO_AUTH_ID = os.getenv("PLIVO_AUTH_ID", "")
PLIVO_AUTH_TOKEN = os.getenv("PLIVO_AUTH_TOKEN", "")
VERIFY_PLIVO_SIGNATURE = os.getenv("VERIFY_PLIVO_SIGNATURE", "false").lower() == "true"

# ---------------- LLM Providers & Models ----------------
# Primary LLM provider: "groq" (default, free LPU inference) or "openai"
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()

# Groq API Key and model fallback chain
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODELS = [
    m.strip()
    for m in os.getenv(
        "GROQ_MODELS",
        "llama-3.3-70b-versatile,llama-3.1-8b-instant,mixtral-8x7b-32768",
    ).split(",")
    if m.strip()
]
GROQ_MODEL = os.getenv("GROQ_MODEL", GROQ_MODELS[0] if GROQ_MODELS else "llama-3.3-70b-versatile")

# OpenAI (optional fallback or primary)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL") or None
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Model used for short call summaries
SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", "llama-3.1-8b-instant" if (GROQ_API_KEY or LLM_PROVIDER == "groq") else OPENAI_MODEL)

# ---------------- Speech-to-Text ----------------
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

# ---------------- Text-to-Speech (TTS) ----------------
# Primary TTS provider: "edge" (free Microsoft Edge TTS), "elevenlabs", "deepgram", or "cartesia"
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "edge").lower()

# Ordered fallback chain if the primary TTS fails
TTS_FALLBACK_PROVIDERS = [
    p.strip().lower()
    for p in os.getenv("TTS_FALLBACK_PROVIDERS", "edge,elevenlabs,deepgram,cartesia").split(",")
    if p.strip()
]

# Edge TTS (Free, no API key needed, Microsoft neural voices)
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-JennyNeural")

# ElevenLabs TTS
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_turbo_v2_5")

# Deepgram TTS
DEEPGRAM_VOICE = os.getenv("DEEPGRAM_VOICE", "aura-2-thalia-en")

# Cartesia TTS
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")
CARTESIA_VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "")

# Safety limit for one call
MAX_CALL_SECONDS = int(os.getenv("MAX_CALL_SECONDS", "900"))
