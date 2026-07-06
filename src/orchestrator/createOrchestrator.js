// The orchestrator: a CPU-only switchboard. It does NO AI work itself. It keeps
// a registry of connected workers, accepts chat jobs from users, routes each
// job to an idle worker, relays streamed tokens back, and recovers when a
// worker vanishes mid-answer.
//
// The job engine is transport-agnostic: every job carries its own emit(event,
// payload) sink and an owner id, so the SAME engine feeds both:
//   - Socket.IO  /workers (compute) and /users (real-time chat)
//   - an HTTP REST + OpenAI-compatible API (/v1/chat/completions, /api/*)
//
// Exposed as a factory so tests can spin up an ephemeral instance and close it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from 'socket.io';

import { config as defaultConfig } from './config.js';
import { Registry, normalizeModel } from './registry.js';
import { pickWeighted } from './selection.js';

export function createOrchestrator(overrides = {}) {
  const cfg = { ...defaultConfig, ...overrides };
  const log = cfg.logger ?? console;

  const registry = new Registry({ floor: cfg.selectionFloor, emaAlpha: cfg.emaAlpha });

  /** @type {Map<string, object>} jobId -> job */
  const jobs = new Map();
  /** @type {string[]} jobIds waiting for a free worker */
  const queue = [];

  // ---- HTTP layer ----------------------------------------------------------
  const app = express();

  // CORS so a browser frontend on any origin can call the REST API. Tighten
  // `corsOrigin` to your frontend's URL in production.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '4mb' }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: cfg.corsOrigin ?? '*' }, // tighten to your frontend origin in prod
  });

  const workersNsp = io.of('/workers');
  const usersNsp = io.of('/users');

  // ---- helpers -------------------------------------------------------------

  function queuePosition(jobId) {
    const i = queue.indexOf(jobId);
    return i < 0 ? 0 : i + 1;
  }

  function removeFromQueue(jobId) {
    const i = queue.indexOf(jobId);
    if (i >= 0) queue.splice(i, 1);
  }

  // Enforce the brand identity server-side: drop any client-supplied system
  // messages (so a user can't reprogram who the assistant claims to be) and
  // prepend our own. Runs per job — the network is stateless, clients send full
  // history each turn, so the system prompt must be re-applied every time.
  function composeMessages(clientMessages) {
    const withoutSystem = clientMessages.filter((m) => m && m.role !== 'system');
    if (!cfg.systemPrompt) return withoutSystem;
    return [{ role: 'system', content: cfg.systemPrompt }, ...withoutSystem];
  }

  function anyWorkerServes(model) {
    if (!model) return registry.size() > 0;
    const wanted = normalizeModel(model);
    return registry.snapshot().some((w) => w.models.includes(wanted));
  }

  function startStallTimer(job, phase) {
    const ms = phase === 'first' ? cfg.firstTokenTimeoutMs : cfg.streamStallTimeoutMs;
    job.timer = setTimeout(() => {
      job.timer = null;
      if (job.status !== 'running') return;
      reassign(job, phase === 'first' ? 'no first token in time' : 'stream stalled');
    }, ms);
    // Don't let a pending timer keep the process (or a test) alive.
    if (typeof job.timer.unref === 'function') job.timer.unref();
  }

  function clearStall(job) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  function assign(job, worker) {
    job.workerId = worker.id;
    job.lastWorkerId = worker.id;
    job.status = 'running';
    job.assignedAt = Date.now();
    job.firstTokenAt = null;
    job.tokenCount = 0;

    registry.setStatus(worker.id, 'busy', job.id);

    job.emit('assigned', {
      jobId: job.id,
      worker: { name: worker.name, tokensPerSec: round1(worker.tokensPerSec) },
    });
    workersNsp.to(worker.id).emit('job', {
      jobId: job.id,
      model: job.model,
      messages: job.messages,
    });

    startStallTimer(job, 'first');
    log.info?.(`[job ${short(job.id)}] -> worker ${worker.name} (${worker.models.join(',')})`);
  }

  function enqueue(job) {
    queue.push(job.id);
    job.status = 'queued';
    job.emit('queued', {
      jobId: job.id,
      position: queuePosition(job.id),
      workersOnline: registry.size(),
    });
  }

  function tryAssignOrQueue(job) {
    const worker = registry.pickIdle(job.model);
    if (worker) {
      assign(job, worker);
      return;
    }
    if (registry.size() > 0 && !anyWorkerServes(job.model)) {
      fail(job, `No connected worker serves model "${job.model}"`);
      return;
    }
    enqueue(job);
  }

  function tryDrain() {
    if (queue.length === 0) return;
    for (const jobId of [...queue]) {
      const job = jobs.get(jobId);
      if (!job) {
        removeFromQueue(jobId);
        continue;
      }
      const worker = registry.pickIdle(job.model);
      if (worker) {
        removeFromQueue(jobId);
        assign(job, worker);
      }
    }
    // Refresh queue positions for whoever is still waiting.
    for (const jobId of queue) {
      const job = jobs.get(jobId);
      if (job) job.emit('queued', { jobId, position: queuePosition(jobId) });
    }
  }

  function reassign(job, reason) {
    clearStall(job);

    // Free the previous worker if it's still connected and still on this job.
    const prev = registry.get(job.workerId);
    if (prev && prev.currentJobId === job.id) registry.setStatus(prev.id, 'idle');

    job.retries += 1;
    if (job.retries > cfg.maxRetries) {
      fail(job, `gave up after ${cfg.maxRetries} reassignment(s): ${reason}`);
      return;
    }

    log.warn?.(`[job ${short(job.id)}] reassigning (${reason}), attempt ${job.retries}`);

    // Tell the client to discard whatever partial answer it has and restart.
    job.emit('restart', { jobId: job.id, reason });

    // Prefer a different worker than the one that just failed us.
    const candidates = registry.idleFor(job.model).filter((w) => w.id !== job.lastWorkerId);
    const worker =
      pickWeighted(candidates, { floor: cfg.selectionFloor }) || registry.pickIdle(job.model);

    job.workerId = null;
    if (worker) {
      assign(job, worker);
    } else {
      queue.unshift(job.id);
      job.status = 'queued';
      job.emit('queued', { jobId: job.id, position: queuePosition(job.id) });
    }
  }

  function complete(job, reportedTps) {
    clearStall(job);
    const worker = registry.get(job.workerId);

    let tps = Number(reportedTps);
    if (!(tps > 0) && job.firstTokenAt && job.tokenCount > 0) {
      const secs = (Date.now() - job.firstTokenAt) / 1000;
      if (secs > 0) tps = job.tokenCount / secs;
    }

    if (worker) {
      if (tps > 0) registry.recordThroughput(worker.id, tps);
      registry.setStatus(worker.id, 'idle');
    }

    job.status = 'done';
    job.emit('done', {
      jobId: job.id,
      tokenCount: job.tokenCount,
      tokensPerSec: worker ? round1(worker.tokensPerSec) : round1(tps),
      workerName: worker ? worker.name : null,
    });
    log.info?.(`[job ${short(job.id)}] done, ${job.tokenCount} tokens`);

    jobs.delete(job.id);
    tryDrain();
  }

  function fail(job, message) {
    clearStall(job);
    job.status = 'failed';
    // 'failed' rather than 'error': 'error' is a reserved event on Socket.IO
    // client sockets and would be swallowed by its internal handling.
    job.emit('failed', { jobId: job.id, message });
    log.warn?.(`[job ${short(job.id)}] failed: ${message}`);
    jobs.delete(job.id);
  }

  function cancelJob(job, { notifyWorker = true } = {}) {
    clearStall(job);
    if (job.status === 'queued') {
      removeFromQueue(job.id);
    } else if (job.status === 'running') {
      const worker = registry.get(job.workerId);
      if (worker) {
        if (notifyWorker) workersNsp.to(worker.id).emit('cancel', { jobId: job.id });
        registry.setStatus(worker.id, 'idle');
      }
    }
    jobs.delete(job.id);
  }

  function cancelJobById(jobId) {
    const job = jobs.get(jobId);
    if (job) cancelJob(job);
  }

  function cancelJobsByOwner(owner) {
    for (const job of [...jobs.values()]) {
      if (job.owner === owner) cancelJob(job);
    }
  }

  // The single entry point for creating a job, shared by every transport
  // (Socket.IO users, the HTTP API, and internal callers like game NPCs later).
  // `emit(event, payload)` is where this job's lifecycle events are delivered;
  // `owner` groups jobs for bulk cancellation on disconnect.
  //   events: queued | assigned | token | restart | done | failed
  function submitJob({ id = randomUUID(), model, messages, owner, emit }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, error: 'messages[] is required' };
    }
    const job = {
      id,
      owner,
      emit: typeof emit === 'function' ? emit : () => {},
      model: model ? normalizeModel(model) : null,
      messages: composeMessages(messages),
      status: 'new',
      workerId: null,
      lastWorkerId: null,
      retries: 0,
      createdAt: Date.now(),
      assignedAt: null,
      firstTokenAt: null,
      tokenCount: 0,
      timer: null,
    };
    jobs.set(job.id, job);
    tryAssignOrQueue(job); // may synchronously emit 'failed' (no worker for model)
    return { ok: true, jobId: job.id };
  }

  // ---- worker namespace ----------------------------------------------------

  workersNsp.on('connection', (socket) => {
    socket.on('register', (payload = {}, ack) => {
      const worker = registry.add(socket.id, {
        name: payload.name,
        models: payload.models,
        tokensPerSec: payload.tokensPerSec,
        key: payload.key,
        connectedAt: Date.now(),
      });
      log.info?.(
        `[worker ${worker.name}] joined, serving [${worker.models.join(', ')}]` +
          (worker.key ? ` (key ${String(worker.key).slice(0, 8)}…)` : ''),
      );
      if (typeof ack === 'function') ack({ ok: true, id: socket.id });
      tryDrain(); // a fresh idle worker may unblock queued jobs
    });

    socket.on('token', ({ jobId, token } = {}) => {
      const job = jobs.get(jobId);
      if (!job || job.status !== 'running' || job.workerId !== socket.id) return;
      if (!job.firstTokenAt) job.firstTokenAt = Date.now();
      job.tokenCount += 1;
      clearStall(job);
      startStallTimer(job, 'stream');
      job.emit('token', { jobId, token });
    });

    socket.on('done', ({ jobId, tokensPerSec } = {}) => {
      const job = jobs.get(jobId);
      if (!job || job.workerId !== socket.id) return;
      complete(job, tokensPerSec);
    });

    socket.on('job_error', ({ jobId, message } = {}) => {
      const job = jobs.get(jobId);
      if (!job || job.workerId !== socket.id) return;
      reassign(job, `worker error: ${message || 'unknown'}`);
    });

    socket.on('disconnect', () => {
      const worker = registry.get(socket.id);
      const jobId = worker?.currentJobId;
      registry.remove(socket.id);
      if (worker) log.info?.(`[worker ${worker.name}] left`);
      if (jobId) {
        const job = jobs.get(jobId);
        if (job && job.status === 'running') reassign(job, 'worker disconnected');
      }
    });
  });

  // ---- user namespace ------------------------------------------------------

  usersNsp.on('connection', (socket) => {
    socket.on('chat', (payload = {}, ack) => {
      const { model, messages } = payload;
      const result = submitJob({
        model,
        messages,
        owner: socket.id,
        emit: (event, data) => socket.emit(event, data),
      });
      if (typeof ack === 'function') ack(result.ok ? { ok: true, jobId: result.jobId } : result);
    });

    socket.on('cancel', ({ jobId } = {}) => {
      const job = jobs.get(jobId);
      if (job && job.owner === socket.id) cancelJob(job);
    });

    socket.on('disconnect', () => {
      cancelJobsByOwner(socket.id);
      tryDrain();
    });
  });

  // ---- HTTP API ------------------------------------------------------------
  // Frontend-friendly surface. Two flavours:
  //   /api/*  — this network's own JSON (live worker + model counts)
  //   /v1/*   — OpenAI-compatible, so existing chat UIs and SDKs work unchanged

  app.get('/health', (_req, res) => res.json({ ok: true, brand: cfg.brandName }));
  app.get('/stats', (_req, res) => res.json(getState()));
  app.get('/api/stats', (_req, res) => res.json(getState()));

  // Models currently served, with how many workers offer each (for a dropdown).
  app.get('/api/models', (_req, res) => {
    const counts = {};
    for (const w of registry.snapshot()) {
      for (const m of w.models) counts[m] = (counts[m] || 0) + 1;
    }
    res.json({
      object: 'list',
      data: Object.entries(counts).map(([id, workers]) => ({ id, object: 'model', workers })),
    });
  });

  // OpenAI-compatible model list.
  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: registry.modelsAvailable().map((id) => ({ id, object: 'model', owned_by: cfg.brandName })),
    });
  });

  // OpenAI-compatible chat completions: non-streaming JSON, or SSE when
  // { "stream": true }. Maps our job lifecycle onto the OpenAI wire format, so a
  // frontend can point any OpenAI client at `<orchestrator>/v1`.
  app.post('/v1/chat/completions', (req, res) => {
    const { model, messages, stream = false } = req.body || {};
    const created = Math.floor(Date.now() / 1000);
    const jobId = randomUUID();

    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ error: { message: 'messages[] is required', type: 'invalid_request_error' } });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let finished = false;
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finishReason = null) =>
        send({
          id: `chatcmpl-${jobId}`,
          object: 'chat.completion.chunk',
          created,
          model: model || null,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
      const finish = () => {
        finished = true;
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const emit = (event, data) => {
        if (finished) return;
        if (event === 'token') chunk({ content: data.token });
        else if (event === 'done') {
          chunk({}, 'stop');
          finish();
        } else if (event === 'failed') {
          send({ error: { message: data.message, type: 'server_error' } });
          finish();
        }
        // 'queued' / 'assigned' / 'restart' have no OpenAI equivalent; ignored.
      };

      const result = submitJob({ id: jobId, model, messages, owner: `http:${jobId}`, emit });
      if (!result.ok) {
        send({ error: { message: result.error, type: 'invalid_request_error' } });
        return finish();
      }
      if (!finished) chunk({ role: 'assistant' }); // opening delta, OpenAI convention
      // res 'close' (not req) — fires when the client disconnects mid-response.
      // req 'close' fires as soon as the body is read, which would cancel early.
      res.on('close', () => {
        if (!finished) {
          finished = true;
          cancelJobById(jobId);
        }
      });
      return;
    }

    // Non-streaming: accumulate, respond once.
    let text = '';
    let finished = false;
    const emit = (event, data) => {
      if (finished) return;
      if (event === 'token') text += data.token;
      else if (event === 'restart') text = '';
      else if (event === 'done') {
        finished = true;
        res.json({
          id: `chatcmpl-${jobId}`,
          object: 'chat.completion',
          created,
          model: model || null,
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: data.tokenCount ?? 0,
            total_tokens: data.tokenCount ?? 0,
          },
        });
      } else if (event === 'failed') {
        finished = true;
        res.status(503).json({ error: { message: data.message, type: 'server_error' } });
      }
    };

    const result = submitJob({ id: jobId, model, messages, owner: `http:${jobId}`, emit });
    if (!result.ok) {
      return res
        .status(400)
        .json({ error: { message: result.error, type: 'invalid_request_error' } });
    }
    // res 'close' (not req 'close', which fires as soon as the body is read).
    res.on('close', () => {
      if (!finished) {
        finished = true;
        cancelJobById(jobId);
      }
    });
  });

  // Model-weight proxy for browser workers. HuggingFace's Xet CDN doesn't send
  // CORS headers, so a browser can't download model weights directly (the
  // requests fail with net::ERR_FAILED). We fetch them server-side (no CORS) and
  // cache to disk, so every worker's browser downloads from THIS origin instead.
  //   /hf/<repo>/resolve/main/<file>  ->  https://huggingface.co/<same>
  const HF_CACHE_DIR = path.resolve(cfg.hfCacheDir ?? 'public/models/_cache');
  app.get('/hf/*', async (req, res) => {
    const rel = req.params[0] || '';
    // Only proxy real model-file fetches, and never allow path traversal.
    if (!rel.includes('/resolve/') || rel.includes('..')) {
      return res.status(400).json({ error: 'bad model path' });
    }

    const cacheFile = path.join(HF_CACHE_DIR, rel);
    const contentType = rel.endsWith('.json') ? 'application/json' : 'application/octet-stream';

    // Download to the disk cache first (once), then always serve from disk. This
    // avoids Content-Length/encoding mismatches that break the browser fetch, and
    // means HuggingFace is hit at most once per file ever.
    if (!fs.existsSync(cacheFile)) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${randomUUID()}.part`;
      const upstreamUrl = `https://huggingface.co/${rel}`;

      // HuggingFace occasionally drops big-file transfers ("terminated"). Retry a
      // few times so one flaky shard doesn't abort a worker's whole model load.
      let cached = false;
      let lastErr;
      for (let attempt = 1; attempt <= 4 && !cached; attempt++) {
        try {
          const upstream = await fetch(upstreamUrl, { redirect: 'follow' });
          if (!upstream.ok || !upstream.body) throw new Error(`HTTP ${upstream.status}`);
          await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(tmp));
          fs.renameSync(tmp, cacheFile);
          cached = true;
          log.info?.(`[hf-proxy] cached ${rel}`);
        } catch (err) {
          lastErr = err;
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          log.warn?.(`[hf-proxy] download attempt ${attempt} failed for ${rel}: ${err.message}`);
        }
      }
      if (!cached) {
        if (!res.headersSent) {
          res.status(502).json({ error: `download failed: ${lastErr?.message || 'unknown'}` });
        }
        return;
      }
    }

    // Serve with sendFile: it sets Content-Length/Type, ETag, Accept-Ranges and
    // handles Range requests — everything the browser Cache API needs. (A hand-
    // rolled stream tripped up cache.add() on large weight shards.)
    res.sendFile(cacheFile, { headers: { 'Content-Type': contentType } }, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });

  // Static frontend, served last so API routes take precedence. Drop an
  // index.html into public/ and it's live at /.
  app.use(express.static('public'));

  // ---- introspection + lifecycle ------------------------------------------

  function getState() {
    return {
      workers: registry.snapshot(),
      workersOnline: registry.size(),
      workersIdle: registry.idleCount(),
      modelsAvailable: registry.modelsAvailable(),
      jobsActive: [...jobs.values()].filter((j) => j.status === 'running').length,
      queueLength: queue.length,
    };
  }

  function listen(port = cfg.port) {
    return new Promise((resolve) => {
      httpServer.listen(port, () => {
        const actual = httpServer.address().port;
        log.info?.(`orchestrator listening on http://localhost:${actual}`);
        resolve(actual);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      for (const job of jobs.values()) clearStall(job);
      io.close(() => {
        httpServer.close(() => resolve());
        // fetch()/browsers keep HTTP connections alive in a pool; without this,
        // httpServer.close() would wait on those idle sockets indefinitely.
        httpServer.closeAllConnections?.();
      });
    });
  }

  return { app, httpServer, io, registry, listen, close, getState, submitJob, config: cfg };
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const short = (id) => String(id).slice(0, 8);
