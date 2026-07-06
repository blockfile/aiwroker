// Shared worker-side plumbing: connect to the orchestrator's /workers
// namespace, register capabilities, and turn each incoming `job` into a call to
// your handler with a small `emit` API. Handles cancellation (user left, or the
// job was reassigned) via an AbortSignal.

import { io } from 'socket.io-client';

/**
 * @param {object}   opts
 * @param {string}   opts.orch          orchestrator base URL, e.g. http://localhost:3000
 * @param {string}   opts.name          friendly worker name shown in /stats
 * @param {string[]} opts.models        model ids this worker can serve
 * @param {number}   opts.tokensPerSec  initial speed estimate (refined by real measurements)
 * @param {string}  [opts.key]          worker key, ties this machine's work to an account (future payouts)
 * @param {(job: {jobId:string, model:string, messages:any[]}, emit: object) => Promise<void>} opts.handleJob
 */
export function connectWorker({ orch, name, models, tokensPerSec, key, handleJob }) {
  const socket = io(`${orch}/workers`, {
    transports: ['websocket'],
    reconnection: true,
  });

  /** @type {Map<string, {cancelled: boolean, ac: AbortController}>} */
  const active = new Map();

  let waiting = false; // whether we're currently in a reconnect-retry loop

  socket.on('connect', () => {
    if (waiting) console.log(`reconnected to ${orch}`);
    else console.log(`connected to ${orch} (socket ${socket.id.slice(0, 6)})`);
    waiting = false;
    socket.emit('register', { name, models, tokensPerSec, key }, (ack) => {
      if (ack?.ok) console.log(`registered as "${name}" serving [${models.join(', ')}]`);
      else console.error('register failed:', ack);
    });
  });

  socket.on('job', async ({ jobId, model, messages }) => {
    const ctl = { cancelled: false, ac: new AbortController() };
    active.set(jobId, ctl);

    const emit = {
      token: (t) => {
        if (!ctl.cancelled) socket.emit('token', { jobId, token: t });
      },
      done: (tokensPerSec) => {
        active.delete(jobId);
        if (!ctl.cancelled) socket.emit('done', { jobId, tokensPerSec });
      },
      error: (message) => {
        active.delete(jobId);
        if (!ctl.cancelled) socket.emit('job_error', { jobId, message: String(message) });
      },
      isCancelled: () => ctl.cancelled,
      signal: ctl.ac.signal,
    };

    console.log(`[job ${jobId.slice(0, 8)}] received (${model || 'any'})`);
    try {
      await handleJob({ jobId, model, messages }, emit);
    } catch (err) {
      if (err?.name === 'AbortError' || ctl.cancelled) return; // cancelled, stay quiet
      emit.error(err?.message || err);
    }
  });

  socket.on('cancel', ({ jobId }) => {
    const ctl = active.get(jobId);
    if (ctl) {
      ctl.cancelled = true;
      ctl.ac.abort();
      active.delete(jobId);
    }
  });

  // On a lost/absent orchestrator, Socket.IO retries forever. Log once, not on
  // every attempt, so the terminal doesn't fill with identical errors.
  socket.on('connect_error', (err) => {
    if (!waiting) {
      waiting = true;
      console.warn(`cannot reach orchestrator at ${orch} (${err.message}) — retrying in the background...`);
    }
  });
  socket.on('disconnect', (reason) => console.log(`disconnected: ${reason}`));

  return socket;
}
