# AIworker

A CPU-first decentralized inference network. Strangers run a **worker** (a CLI, or
later a browser tab); their machine does the actual AI generation. A small
**orchestrator** routes each user's prompt to an available worker and streams the
answer back. The orchestrator does **no AI work** — it's a switchboard, so it runs
fine on a cheap CPU-only VPS.

This repo is the **backend**: orchestrator + workers + a CLI test client. The web
frontend (chat UI + worker page) comes next and drops into [`public/`](public/),
which the orchestrator already serves.

```
  user (browser / CLI)                         worker (someone's PC)
        │  prompt                                     ▲  │ tokens
        ▼                                             │  ▼
  ┌───────────────────────  orchestrator  ──────────────────────┐
  │  /users namespace        /workers namespace                 │
  │  • accept chat jobs      • worker registry (model, tok/s)   │
  │  • queue when busy       • idle/busy status                 │
  │  • relay tokens back     • weighted-random selection        │
  │  • stall detection + automatic reassignment                 │
  │  does ZERO inference — pure CPU, ~a few hundred lines        │
  └─────────────────────────────────────────────────────────────┘
```

## Why CPU is fine

- **Orchestrator:** never runs a model. CPU-only, always was.
- **Workers:** [Ollama](https://ollama.com) runs models on CPU out of the box —
  just pick a small quantized model. GPU workers join the same network unchanged;
  they just report higher tokens/sec and get picked more often.

Rough CPU expectations (quantized, modern desktop CPU):

| Model | Speed | Feel |
|---|---|---|
| `qwen2.5:0.5b` / `qwen2.5:1.5b` | ~15–30 tok/s | basic chat, quick Q&A |
| `llama3.2:3b` / `phi3:mini` | ~8–15 tok/s | decent everyday answers |
| `qwen2.5:7b` | ~3–8 tok/s | noticeably better, slower to read |

The orchestrator weights job assignment by measured tokens/sec, so slow CPU
workers naturally receive fewer jobs without any special handling.

## Quick start (no model needed)

```bash
npm install

# terminal 1 — the orchestrator
npm start

# terminal 2 — a fake worker that streams canned replies
npm run worker:mock

# terminal 3 — ask a question (stand-in for the frontend)
node scripts/chat.js "hello, are you working?"
```

You'll watch the answer stream in token by token. Start several mock workers to
see queueing and load-spreading; close a worker mid-answer to watch the
orchestrator reassign the job.

## Real inference on CPU

```bash
# one-time: install a small model (Ollama picks CPU/GPU automatically)
ollama pull qwen2.5:1.5b

# terminal 2 — a real worker bridging to local Ollama
MODEL=qwen2.5:1.5b npm run worker

# terminal 3
MODEL=qwen2.5:1.5b node scripts/chat.js "explain websockets in one sentence"
```

On Windows PowerShell, set env vars inline like:
`$env:MODEL="qwen2.5:1.5b"; npm run worker`

## Letting other people contribute their CPU

This is the network effect: strangers run the worker, their CPU does the
inference, your orchestrator just routes. It works because **the worker connects
outward** over a websocket — the contributor needs no port forwarding, no
firewall changes, nothing installed on your side.

Two things make it real:

**1. Your orchestrator must be reachable over the internet.** On `localhost` only
you can connect. Options:
- *Quick test:* a tunnel (`cloudflared tunnel --url http://localhost:3000` or
  `ngrok http 3000`) gives you a public URL in seconds — hand it to a friend and
  they can join from their house.
- *Real deployment:* run the orchestrator on a small VPS / droplet with a domain
  + TLS behind nginx (WebSocket upgrade headers). It does no AI work, so a tiny
  box coordinates many heavy workers.

**2. Others join** — two onboarding paths, same protocol underneath:

**a) Browser worker — 1 click, zero install (uses their GPU).**
Send them `https://your-server.com/worker.html`. They pick a model and click
Start; the browser runs the model via WebLLM/WebGPU. No Node, no npm, no Ollama —
just Chrome/Edge on a machine with a GPU. Optional query params: `?name=`,
`?key=`, `?orch=` (if the page is hosted apart from the orchestrator), and
`?weights=hf` (skip the proxy below, download straight from HuggingFace). The page
registers a distinct model name (e.g. `qwen2.5-1.5b-web`) so browser and native
models don't collide — it's shown on the page.

Two things make this actually work, both handled for you:
- **Model weights are proxied through your server** (`/hf/...`). HuggingFace's CDN
  doesn't send CORS headers, so a browser can't download the weights directly
  (they fail with `net::ERR_FAILED`). The orchestrator fetches them server-side
  (no CORS) and caches them under `public/models/_cache/`, so HuggingFace is hit
  at most once per file and every worker downloads from *you*.
- **Weights are stored in IndexedDB** (not the Cache API), which is far more
  reliable for large model files across browsers.

Verified end to end: a browser tab loads Qwen through the proxy, registers, and
serves a real chat answer over the OpenAI API.

**b) Native worker — one command (uses their CPU or GPU).**
```bash
# from this repo
node src/workers/native-worker.js --url https://your-server.com

# or, once you publish this package to npm, no clone needed:
npx core-ai-worker --url https://your-server.com
```
On first run it **auto-installs Ollama** (winget on Windows, Homebrew on macOS,
the install script on Linux), **starts it**, and **downloads the model** — the
person just runs the one command and waits. `--help` lists all flags:
- `--model qwen2.5:1.5b` — which model to serve (small = lighter on the CPU)
- `--threads 2` — low-CPU mode: cap the cores used so their PC stays responsive
- `--name MyRig`, `--key <key>` — identity / future-payout attribution
- `--no-setup` — skip the auto-install if they've set Ollama up themselves

To publish it as an installable `npx core-ai-worker` command, set a unique
`name` in `package.json` and `npm publish` (the `bin` entry is already wired).
Requires Node installed (that's what `npx` needs); for a truly zero-install CPU
worker you'd ship a packaged `.exe`.

| Path | Their effort | Runs on | Install |
|---|---|---|---|
| `/worker.html` | click a button | GPU (WebGPU) | nothing but a browser |
| `native-worker` CLI | one command | CPU or GPU | Node + Ollama (auto-installable) |

## Branding (make the AI present as *your* product)

Open-weight models introduce themselves as their vendor ("I'm Qwen, made by
Alibaba"). The orchestrator fixes this by prepending a **brand system prompt** to
every job and stripping any client-supplied system message, so identity is
enforced network-wide and can't be overridden by a user. Set your name:

```bash
BRAND_NAME=NovaChat npm start
```

Now the assistant calls itself NovaChat. Notes:

- **Model size matters for adherence.** A 0.5B model will adopt the name but may
  still leak the vendor; 1.5B–7B models follow the identity instruction reliably.
  Use `qwen2.5:1.5b` or larger for consistent branding.
- Override the whole instruction with `SYSTEM_PROMPT=...`, or set it empty to
  disable identity injection.
- This is also the seam for the future per-persona / agent marketplace: layer a
  persona prompt on top of the brand prompt per job.

## Configuration

Copy `.env.example` to `.env` and run with `node --env-file=.env ...`, or set
environment variables directly. Key ones:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | orchestrator port |
| `FIRST_TOKEN_TIMEOUT_S` | `90` | grace period for a CPU worker to emit its first token before reassigning |
| `STREAM_STALL_TIMEOUT_S` | `30` | silence mid-stream before treating a worker as dead |
| `MAX_RETRIES` | `2` | reassignments before a job fails |
| `ORCH` | `http://localhost:3000` | where a worker connects |
| `MODEL` | `qwen2.5:1.5b` | model the native worker serves / the client requests |
| `OLLAMA_URL` | `http://localhost:11434` | local Ollama endpoint |

## Layout

```
src/orchestrator/
  server.js             runnable entry point
  createOrchestrator.js Socket.IO wiring, job lifecycle, streaming relay, reassignment
  registry.js           worker registry + model matching (unit-tested)
  selection.js          weighted-random pick + tokens/sec EMA (unit-tested)
  config.js             env-driven config with CPU-friendly defaults
src/workers/
  lib.js                shared worker client (connect, register, job/cancel handling)
  native-worker.js      real worker: bridges to local Ollama over HTTP streaming
  mock-worker.js        canned-reply worker for testing without a model
scripts/
  chat.js               CLI user client (the frontend stand-in)
test/
  selection.test.js     unit tests
  e2e.test.js           full route/stream/queue/reassign flow against a live orchestrator
public/                 the frontend goes here (served statically already)
```

## HTTP API (for the frontend / third-party apps)

CORS is enabled, so a browser app on any origin can call these. Two flavours:
this network's own `/api/*` JSON, and an **OpenAI-compatible `/v1/*`** surface so
existing chat UIs and SDKs work with zero changes.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness + brand name |
| `GET` | `/api/stats` | workers online/idle, models, active jobs, queue length |
| `GET` | `/api/models` | served models, each with a live worker count (for a dropdown) |
| `GET` | `/v1/models` | OpenAI-compatible model list |
| `POST` | `/v1/chat/completions` | chat, non-streaming JSON or SSE streaming |

**Non-streaming** — a normal JSON completion:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"hi"}]}'
```

**Streaming** — Server-Sent Events, OpenAI `chat.completion.chunk` format ending
in `data: [DONE]`:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Because it's OpenAI-shaped, a frontend can use the official OpenAI SDK or the
Vercel AI SDK by pointing `baseURL` at `http://your-server:3000/v1` — no API key
needed (add auth later). The brand system prompt is still enforced server-side.

The system prompt is injected and any client-supplied `system` message is
stripped, so identity holds regardless of transport. Note: the HTTP request
blocks while a job is queued waiting for a free worker; set a client-side timeout.

For token-by-token UI with the richest events (queue position, worker name,
mid-stream reassignment), the Socket.IO protocol below is the better fit.

## Protocol (for building the frontend)

**User → orchestrator** (`/users` namespace):
- `chat` `{ model, messages: [{role, content}, ...] }`, ack `{ ok, jobId }` — send the
  full history each turn; the server is stateless.
- `cancel` `{ jobId }`

**Orchestrator → user:**
- `queued` `{ jobId, position, workersOnline }`
- `assigned` `{ jobId, worker: { name, tokensPerSec } }`
- `token` `{ jobId, token }` — append to the answer
- `restart` `{ jobId, reason }` — discard partial output, a fresh stream follows
- `done` `{ jobId, tokenCount, tokensPerSec, workerName }`
- `failed` `{ jobId, message }`

**Worker → orchestrator** (`/workers` namespace):
- `register` `{ name, models: [...], tokensPerSec }`, ack `{ ok, id }`
- `token` `{ jobId, token }` · `done` `{ jobId, tokensPerSec }` · `job_error` `{ jobId, message }`

**Orchestrator → worker:** `job` `{ jobId, model, messages }` · `cancel` `{ jobId }`

## Tests

```bash
npm test
```

## Deploying

Put the orchestrator behind nginx with WebSocket upgrade headers and a TLS cert —
that encrypts all traffic in transit (HTTPS/WSS). Note the inherent privacy limit
of any "other people's GPUs" model: the worker that serves a job sees the prompt
in plaintext, because the model has to read it to answer. The server stays
stateless (stores no conversations); strip identity from jobs and say so plainly
in your docs.

## Deliberately not built yet

In the order you'd add them: wallet-signature auth + credit ledger → per-token
billing and worker payouts → **output verification** (spot-check duplicate jobs +
worker reputation) before real money flows, since fake-output credit farming is
the first attack once earnings are real.
