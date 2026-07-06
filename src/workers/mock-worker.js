// A worker that needs no model and no GPU. It streams a canned reply token by
// token, so you can exercise the whole route/stream/settle path before pulling
// any real model. Start several to watch queueing and load-spreading.
//   npm run worker:mock

import { connectWorker } from './lib.js';

const ORCH = process.env.ORCH || 'http://localhost:3000';
const MODEL = process.env.MODEL || 'mock';
const NAME = process.env.WORKER_NAME || `mock-${Math.random().toString(36).slice(2, 6)}`;
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

connectWorker({
  orch: ORCH,
  name: NAME,
  models: [MODEL],
  tokensPerSec: 40,
  async handleJob({ messages }, emit) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '(no prompt)';
    const reply =
      `You said: "${prompt}". ` +
      `This is a canned reply from ${NAME}. ` +
      `Routing, streaming, stall-recovery, and settlement all work end to end — ` +
      `swap me for the native Ollama worker to get real answers.`;

    const words = reply.split(' ');
    const start = Date.now();
    let count = 0;
    for (const word of words) {
      if (emit.isCancelled()) return;
      await sleep(DELAY_MS);
      emit.token(word + ' ');
      count++;
    }
    const secs = (Date.now() - start) / 1000;
    emit.done(secs > 0 ? count / secs : 0);
  },
});

console.log(`mock worker "${NAME}" starting -> ${ORCH} (advertises model "${MODEL}")`);
