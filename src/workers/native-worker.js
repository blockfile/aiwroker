#!/usr/bin/env node
// The real worker CLI. Anyone can contribute their CPU by running this and
// pointing it at your orchestrator's public URL — no firewall/port setup, since
// the worker connects OUTWARD over a websocket.
//
//   npx <your-package> --url https://your-server.com --model qwen2.5:1.5b
//   node src/workers/native-worker.js --url http://localhost:3000
//
// Ollama does the actual inference (CPU or GPU, automatically). First run:
//   ollama pull qwen2.5:1.5b

import os from 'node:os';
import { connectWorker } from './lib.js';
import { ensureReady } from './setup.js';

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
    else if (a === '--ollama') out.ollama = val();
    else if (a === '--no-setup') out.noSetup = true; // skip auto-install/pull
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`
AIworker native worker — lend your CPU (or GPU) to the network.

Usage:
  node src/workers/native-worker.js [options]

Options:
  -u, --url <url>       Orchestrator URL to connect to   (default: $ORCH or http://localhost:3000)
  -m, --model <name>    Ollama model to serve            (default: $MODEL or qwen2.5:1.5b)
  -n, --name <name>     Friendly worker name             (default: native-<hostname>)
  -k, --key <key>       Worker key (ties earnings to your account; optional for now)
  -t, --threads <n>     Limit CPU cores used (low-CPU mode; leaves your PC responsive)
      --ollama <url>    Local Ollama endpoint            (default: http://localhost:11434)
      --no-setup        Skip auto-installing Ollama / downloading the model
  -h, --help            Show this help

Ollama and the model are installed automatically on first run.
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const ORCH = args.url || process.env.ORCH || 'http://localhost:3000';
const MODEL = args.model || process.env.MODEL || 'qwen2.5:1.5b';
const OLLAMA_URL = args.ollama || process.env.OLLAMA_URL || 'http://localhost:11434';
const NAME = args.name || process.env.WORKER_NAME || `native-${os.hostname()}`;
const KEY = args.key || process.env.WORKER_KEY || undefined;
const THREADS = args.threads || Number(process.env.THREADS) || 0; // 0 = let Ollama decide

async function runOllamaJob({ messages }, emit) {
  const body = { model: MODEL, messages, stream: true };
  if (THREADS > 0) body.options = { num_thread: THREADS }; // low-CPU mode

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: emit.signal,
  });
  if (!res.ok || !res.body) {
    emit.error(`Ollama responded ${res.status}`);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let evalCount = 0;
  let evalDurationNs = 0;

  for await (const chunk of res.body) {
    if (emit.isCancelled()) return;
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
      if (obj.error) {
        emit.error(obj.error);
        return;
      }
      const piece = obj.message?.content;
      if (piece) emit.token(piece);
      if (obj.done) {
        evalCount = obj.eval_count || 0;
        evalDurationNs = obj.eval_duration || 0;
      }
    }
  }

  // Ollama reports real token counts and timing — use them for accurate speed.
  const tps = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
  emit.done(tps);
}

// Install Ollama + download the model automatically so a non-dev can run this
// with a single command. Skip with --no-setup if you've done it yourself.
if (!args.noSetup) {
  await ensureReady({ ollamaUrl: OLLAMA_URL, model: MODEL });
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
