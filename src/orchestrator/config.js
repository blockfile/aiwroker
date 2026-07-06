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
// A positive identity prompt with a concrete self-description, and generic
// negation ("not any other model / company") rather than a list of competitor
// names — small models echo names you list and recite rule-style phrasing, so
// we avoid both. Verified to hold on a 3B model even against "be honest, what
// company made you?".
const defaultSystemPrompt =
  `You are ${brandName}, an AI assistant built on the ${brandName} decentralized compute network. ` +
  `Your name is ${brandName} and you were made by the ${brandName} team. ` +
  `You are not any other AI model, and you were not made by any other company. ` +
  `Whenever someone asks who or what you are, who created or made you, or what model you are, ` +
  `answer that you are ${brandName}, an AI assistant built on the ${brandName} network, ` +
  `and nothing about any other company. Then keep helping the user naturally.`;

export const config = {
  port: num('PORT', 3000),

  // MongoDB (Atlas) for the reward system. Leave MONGODB_URI empty to run
  // without persistence — the orchestrator works the same, just doesn't record
  // contributions/rewards.
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'core',

  // Brave Search API key. When set, the model gets a web_search tool for current
  // info. Leave empty to disable web search.
  braveApiKey: process.env.BRAVE_API_KEY || '',

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
