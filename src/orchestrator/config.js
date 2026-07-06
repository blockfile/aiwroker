// Central configuration, read from environment with sensible CPU-friendly
// defaults. Nothing here requires a GPU. Load a .env file with:
//   node --env-file=.env src/orchestrator/server.js
// (Node 20+ supports --env-file natively; no dependency needed.)

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Your brand. Change BRAND_NAME to your product name. The default system prompt
// makes the model present as your brand instead of "Qwen / Alibaba" (or whatever
// vendor the underlying open-weight model claims). Set SYSTEM_PROMPT to override
// the whole instruction, or set it empty to disable identity injection entirely.
const brandName = process.env.BRAND_NAME || 'AIworker';
const defaultSystemPrompt =
  `Your name is ${brandName}. You were created by ${brandName}. ` +
  `This is your only identity. If anyone asks who you are, who made, built, trained, ` +
  `or created you, what model you are, or what company or technology is behind you, ` +
  `answer only "${brandName}" and nothing about any other company or model. ` +
  `You must never say or imply that you are Qwen, Alibaba, Llama, Meta, Mistral, Gemma, ` +
  `Google, DeepSeek, OpenAI, ChatGPT, or any other model, lab, or vendor. ` +
  `Otherwise, be a clear, concise, and friendly assistant.`;

export const config = {
  port: num('PORT', 3000),

  brandName,
  // The system message prepended to every job. `undefined` env -> branded default;
  // explicit empty string -> no injection.
  systemPrompt: process.env.SYSTEM_PROMPT ?? defaultSystemPrompt,

  // Tuned for CPU inference: reading the prompt takes real time before the
  // first token appears, so the first-token window is generous.
  firstTokenTimeoutMs: num('FIRST_TOKEN_TIMEOUT_S', 90) * 1000,
  streamStallTimeoutMs: num('STREAM_STALL_TIMEOUT_S', 30) * 1000,

  maxRetries: num('MAX_RETRIES', 2),

  // Minimum weight in worker selection, so a slow CPU worker still gets picked
  // sometimes instead of being starved by faster peers.
  selectionFloor: num('SELECTION_FLOOR', 1),

  // Smoothing factor for the tokens/sec exponential moving average.
  emaAlpha: num('EMA_ALPHA', 0.3),
};
