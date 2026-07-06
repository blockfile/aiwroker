import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

import { createOrchestrator } from '../src/orchestrator/createOrchestrator.js';

const silentLogger = { info() {}, warn() {}, error() {} };

async function withOrchestrator(fn, overrides = {}) {
  const orch = createOrchestrator({ logger: silentLogger, ...overrides });
  const port = await orch.listen(0);
  const base = `http://localhost:${port}`;
  try {
    await fn({ orch, base });
  } finally {
    await orch.close();
  }
}

function connectWorker(base, { name, models, tokensPerSec = 10, handle }) {
  const socket = io(`${base}/workers`, { transports: ['websocket'] });
  socket.on('job', (job) => handle({ ...job, socket }));
  const ready = new Promise((resolve) =>
    socket.on('connect', () => socket.emit('register', { name, models, tokensPerSec }, resolve)),
  );
  return { socket, ready };
}

// A worker that ignores the prompt and streams a fixed two-token reply.
function echoHandle({ jobId, socket }) {
  socket.emit('token', { jobId, token: 'Hello ' });
  socket.emit('token', { jobId, token: 'world' });
  socket.emit('done', { jobId, tokensPerSec: 10 });
}

function parseSSE(raw) {
  let text = '';
  let sawStop = false;
  let sawDone = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    const obj = JSON.parse(payload);
    const choice = obj.choices?.[0];
    if (choice?.delta?.content) text += choice.delta.content;
    if (choice?.finish_reason === 'stop') sawStop = true;
  }
  return { text, sawStop, sawDone };
}

test('GET /api/models lists served models with worker counts', async () => {
  await withOrchestrator(async ({ base }) => {
    const w = connectWorker(base, { name: 'W', models: ['mock'], handle: echoHandle });
    await w.ready;

    const body = await (await fetch(`${base}/api/models`)).json();
    assert.equal(body.object, 'list');
    const mock = body.data.find((m) => m.id === 'mock');
    assert.ok(mock, 'mock model listed');
    assert.equal(mock.workers, 1);

    w.socket.close();
  });
});

test('POST /v1/chat/completions (non-streaming) returns an OpenAI-shaped completion', async () => {
  await withOrchestrator(async ({ base }) => {
    const w = connectWorker(base, { name: 'W', models: ['mock'], handle: echoHandle });
    await w.ready;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.usage.completion_tokens, 2);

    w.socket.close();
  });
});

test('POST /v1/chat/completions (streaming) emits SSE deltas then [DONE]', async () => {
  await withOrchestrator(async ({ base }) => {
    const w = connectWorker(base, { name: 'W', models: ['mock'], handle: echoHandle });
    await w.ready;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const { text, sawStop, sawDone } = parseSSE(await res.text());
    assert.equal(text, 'Hello world');
    assert.ok(sawStop, 'a stop finish_reason chunk was sent');
    assert.ok(sawDone, 'the [DONE] sentinel was sent');

    w.socket.close();
  });
});

test('POST /v1/chat/completions rejects a request with no messages (400)', async () => {
  await withOrchestrator(async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /messages/);
  });
});

test('POST /v1/chat/completions fails cleanly when no worker serves the model', async () => {
  await withOrchestrator(async ({ base }) => {
    const w = connectWorker(base, { name: 'W', models: ['mock'], handle: echoHandle });
    await w.ready;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ghost', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error.message, /No connected worker serves/);

    w.socket.close();
  });
});

test('/hf proxy rejects bad paths and serves cached model files from disk', async () => {
  const cacheDir = path.join(os.tmpdir(), `aiworker-hf-${Date.now()}`);
  const fileDir = path.join(cacheDir, 'mlc-ai/Demo/resolve/main');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(path.join(fileDir, 'ndarray-cache.json'), '{"cached":true}');

  try {
    await withOrchestrator(
      async ({ base }) => {
        // Missing "/resolve/" -> rejected, and no path traversal allowed.
        assert.equal((await fetch(`${base}/hf/no-resolve-here`)).status, 400);

        // A cached file is served straight from disk (no network needed).
        const res = await fetch(`${base}/hf/mlc-ai/Demo/resolve/main/ndarray-cache.json`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await res.json(), { cached: true });
      },
      { hfCacheDir: cacheDir },
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CORS headers are present for browser access', async () => {
  await withOrchestrator(async ({ base }) => {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const preflight = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
  });
});
