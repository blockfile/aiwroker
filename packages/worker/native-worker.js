#!/usr/bin/env node
// Lend your CPU to the Core AI network — one command, no clone, no config:
//
//   npx core-ai-worker --key <your-solana-wallet-address>
//
// It auto-installs Ollama, downloads a small model, and connects to the network.
// The worker reaches OUTWARD over a websocket, so there's no firewall/port setup.
// Ollama does the inference on your CPU (or GPU if you have one).

import os from 'node:os';
import { connectWorker } from './lib.js';
import { ensureReady } from './setup.js';

// Dependency-free Solana address check (mirrors the orchestrator's). A valid
// address is a base58-encoded 32-byte key — reject typos so earnings aren't lost.
function isValidSolanaAddress(addr) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof addr !== 'string' || addr.length < 32 || addr.length > 44) return false;
  const bytes = [];
  for (const ch of addr) {
    const val = ALPHABET.indexOf(ch);
    if (val === -1) return false;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  let zeros = 0;
  for (let k = 0; k < addr.length && addr[k] === '1'; k++) zeros++;
  return bytes.length + zeros === 32;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--url' || a === '-u') out.url = val();
    else if (a === '--model' || a === '-m') out.model = val();
    else if (a === '--name' || a === '-n') out.name = val();
    else if (a === '--key' || a === '-k') out.key = val();
    else if (a === '--threads' || a === '-t') out.threads = Number(val());
    else if (a === '--cpu') out.cpu = true; // force CPU (skip a too-small GPU)
    else if (a === '--ollama') out.ollama = val();
    else if (a === '--no-setup') out.noSetup = true; // skip auto-install/pull
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`
core-ai-worker — lend your CPU to the Core AI network.

Usage:
  npx core-ai-worker --key <your-solana-wallet-address> [options]

Options:
  -k, --key <address>   Your Solana wallet address — earnings go here
  -u, --url <url>       Network URL to connect to        (default: https://api.blacktroll.meme)
  -m, --model <name>    Ollama model to serve            (default: qwen2.5:1.5b)
  -n, --name <name>     Friendly worker name             (default: native-<hostname>)
  -t, --threads <n>     Limit CPU cores used (low-CPU mode; leaves your PC responsive)
      --cpu             Force CPU (use if a bigger model won't fit your GPU)
      --ollama <url>    Local Ollama endpoint            (default: http://localhost:11434)
      --no-setup        Skip auto-installing Ollama / downloading the model
  -h, --help            Show this help

Weak PC? Try:  npx core-ai-worker --key <addr> --model qwen2.5:0.5b --threads 2
Ollama and the model are installed automatically on first run.
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const ORCH = args.url || process.env.ORCH || 'https://api.blacktroll.meme';
const MODEL = args.model || process.env.MODEL || 'qwen2.5:1.5b';
const OLLAMA_URL = args.ollama || process.env.OLLAMA_URL || 'http://localhost:11434';
const NAME = args.name || process.env.WORKER_NAME || `native-${os.hostname()}`;
const KEY = args.key || process.env.WORKER_KEY || undefined;
const THREADS = args.threads || Number(process.env.THREADS) || 0; // 0 = let Ollama decide
const FORCE_CPU = args.cpu || process.env.FORCE_CPU === '1'; // skip the GPU entirely

// A key is optional, but if given it must be your Solana wallet address (that's
// where earnings go) — reject typos before wasting a download/connection.
if (KEY && !isValidSolanaAddress(KEY)) {
  console.error(`\n"${KEY}" is not a valid Solana wallet address.`);
  console.error('Use your Solana wallet address as the key, e.g.:');
  console.error('  npx core-ai-worker --key <your-solana-address>');
  process.exit(1);
}

// One streaming call to Ollama. Streams content tokens via emit, collects any
// tool calls, and returns { content, toolCalls, tps, cancelled }.
async function callOllama(messages, tools, emit) {
  // Let Ollama use whatever hardware fits best (GPU if the model fits its VRAM,
  // else CPU). Add --cpu to force CPU on machines whose GPU is too small.
  const body = { model: MODEL, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  const options = {};
  if (FORCE_CPU) options.num_gpu = 0;
  if (THREADS > 0) options.num_thread = THREADS; // low-CPU mode
  if (Object.keys(options).length) body.options = options;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: emit.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`Ollama ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  let evalCount = 0;
  let evalDurationNs = 0;

  for await (const chunk of res.body) {
    if (emit.isCancelled()) return { cancelled: true };
    buffer += decoder.decode(chunk, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // partial/garbled line, skip
      }
      if (obj.error) throw new Error(obj.error);
      const piece = obj.message?.content;
      if (piece) {
        emit.token(piece);
        content += piece;
      }
      if (obj.message?.tool_calls) toolCalls.push(...obj.message.tool_calls);
      if (obj.done) {
        evalCount = obj.eval_count || 0;
        evalDurationNs = obj.eval_duration || 0;
      }
    }
  }

  const tps = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
  return { content, toolCalls, tps };
}

async function runOllamaJob({ messages, tools }, emit) {
  let msgs = messages;
  let tps = 0;
  const MAX_STEPS = 3; // model may search a couple of times before answering

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await callOllama(msgs, tools, emit);
    if (r.cancelled) return;
    if (r.tps) tps = r.tps;

    // No tool call -> the model answered (already streamed). Done.
    if (!r.toolCalls || r.toolCalls.length === 0) {
      emit.done(tps);
      return;
    }

    // The model asked for a tool. Run each call and feed the result back, then loop.
    msgs = [...msgs, { role: 'assistant', content: r.content || '', tool_calls: r.toolCalls }];
    for (const tc of r.toolCalls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      let result = 'Tool not available.';
      if (name === 'web_search' && args?.query && emit.search) {
        result = await emit.search(args.query);
      }
      msgs.push({ role: 'tool', content: String(result) });
    }
  }

  emit.done(tps); // ran out of steps — finish with whatever we have
}

// Install Ollama + download the model automatically so a non-dev can run this
// with a single command. Skip with --no-setup if you've done it yourself.
if (!args.noSetup) {
  try {
    await ensureReady({ ollamaUrl: OLLAMA_URL, model: MODEL });
  } catch (err) {
    console.error(`\nSetup couldn't finish: ${err.message}`);
    console.error('Install Ollama from https://ollama.com, then run this again.');
    process.exit(1);
  }
}

connectWorker({
  orch: ORCH,
  name: NAME,
  models: [MODEL],
  tokensPerSec: 8, // conservative CPU seed; corrected after the first real job
  key: KEY,
  handleJob: runOllamaJob,
});

console.log(`native worker "${NAME}" -> ${ORCH}  (model "${MODEL}" via ${OLLAMA_URL})`);
if (THREADS > 0) console.log(`low-CPU mode: using up to ${THREADS} core(s)`);
if (KEY) console.log(`worker key: ${String(KEY).slice(0, 10)}…`);
console.log('waiting for jobs — press Ctrl+C to stop.');
