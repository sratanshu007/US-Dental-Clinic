// Voice agent settings (environment / .env). Every AI vendor here needs a signed BAA before real patient calls.
import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const env = (name: string, fallback = "") => process.env[name] ?? fallback;

const LLM_BASES: Record<string, string> = { openai: "https://api.openai.com/v1", xai: "https://api.x.ai/v1" };
const llmProvider = env("LLM_PROVIDER", "openai").toLowerCase();
const llmModel = env("OPENAI_MODEL", env("LLM_MODEL", llmProvider === "openai" ? "gpt-4o-mini" : ""));
if (!llmModel) throw new Error("Set OPENAI_MODEL or LLM_MODEL in environment variables for your LLM provider");

function normalizeUrl(url: string, defaultProtocol = "https://"): string {
  if (!url) return "";
  let trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.startsWith("http://localhost") || trimmed.startsWith("https://localhost") || trimmed.includes("localhost:")) {
    return trimmed.startsWith("http") ? trimmed : `http://${trimmed}`;
  }
  let host = trimmed.replace(/^https?:\/\//, "");
  if (host === "dental-api" || host.startsWith("dental-api:")) {
    host = "dental-api-7h2u.onrender.com";
  } else if (!host.includes(".")) {
    host = `${host}.onrender.com`;
  }
  return `https://${host}`;
}

const rawPublicUrl = env("PUBLIC_URL") || env("RENDER_EXTERNAL_URL") || "https://dental-voice-pfb7.onrender.com";
const rawApiUrl = env("API_URL") || env("BACKEND_API_URL") || "https://dental-api-7h2u.onrender.com";

export const config = {
  env: env("NODE_ENV", "development"),
  port: Number(env("PORT", "7860")),
  // Public HTTPS URL of THIS service (Plivo calls it), e.g. https://voice.yourdomain.com
  publicUrl: normalizeUrl(rawPublicUrl),
  apiUrl: normalizeUrl(rawApiUrl),
  internalApiKey: req("INTERNAL_API_KEY"),

  plivo: {
    authId: env("PLIVO_AUTH_ID"),
    authToken: env("PLIVO_AUTH_TOKEN"),
    apiBase: env("PLIVO_API_BASE", "https://api.plivo.com").replace(/\/$/, ""),
    verifySignature: env("VERIFY_PLIVO_SIGNATURE", "true").toLowerCase() === "true",
  },

  llm: {
    provider: llmProvider,
    apiKey: env("OPENAI_API_KEY") || env("XAI_API_KEY"),
    baseUrl: (env("OPENAI_BASE_URL") || LLM_BASES[llmProvider] || LLM_BASES.openai).replace(/\/$/, ""),
    model: llmModel,
    summaryModel: env("SUMMARY_MODEL", llmModel),
    temperature: Number(env("LLM_TEMPERATURE", "0.6")),
    // Phone replies are short; a low cap also keeps the model fast
    maxTokens: Number(env("LLM_MAX_TOKENS", "180")),
  },

  deepgram: {
    apiKey: env("DEEPGRAM_API_KEY"),
    // Overridable for tests / regional endpoints
    wsUrl: env("DEEPGRAM_WS_URL", "wss://api.deepgram.com/v1/listen"),
    apiUrl: env("DEEPGRAM_API_URL", "https://api.deepgram.com/v1"),
    sttModel: env("DEEPGRAM_STT_MODEL", "nova-3"),
    voice: env("DEEPGRAM_VOICE", "aura-2-thalia-en"),
    // Silence (ms) that ends the caller's turn
    endpointingMs: Number(env("ENDPOINTING_MS", "300")),
    // Extra wait when the caller seems mid-sentence ("my name is...", "um", "and")
    incompleteWaitMs: Number(env("INCOMPLETE_WAIT_MS", "700")),
    // If no reply audio has started this long after the caller stopped, say a quick "Mm-hmm." (0 = off)
    thinkingAckMs: Number(env("THINKING_ACK_MS", "900")),
  },

  maxCallSeconds: Number(env("MAX_CALL_SECONDS", "900")),
  logLevel: env("LOG_LEVEL", "info"),
};
