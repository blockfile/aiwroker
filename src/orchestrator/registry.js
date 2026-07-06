// The worker registry: who is connected, what they serve, how fast they are,
// and whether they are free right now. Pure data structure + selection — the
// socket layer drives it. Unit-tested in test/selection.test.js.

import { pickWeighted, updateEma } from './selection.js';

export class Registry {
  constructor({ floor = 1, emaAlpha = 0.3 } = {}) {
    /** @type {Map<string, object>} socketId -> worker */
    this.workers = new Map();
    this.floor = floor;
    this.emaAlpha = emaAlpha;
  }

  add(id, { name, models, tokensPerSec, connectedAt, key }) {
    const worker = {
      id,
      name: name || id.slice(0, 6),
      models: (models && models.length ? models : []).map(normalizeModel),
      tokensPerSec: Number(tokensPerSec) > 0 ? Number(tokensPerSec) : this.floor,
      status: 'idle',
      currentJobId: null,
      connectedAt: connectedAt ?? null,
      // Identifies which account this machine's work (and future earnings)
      // belongs to. Not validated yet — that arrives with the accounts layer.
      key: key ?? null,
      jobsCompleted: 0,
    };
    this.workers.set(id, worker);
    return worker;
  }

  remove(id) {
    const worker = this.workers.get(id);
    this.workers.delete(id);
    return worker || null;
  }

  get(id) {
    return this.workers.get(id) || null;
  }

  setStatus(id, status, jobId = null) {
    const w = this.workers.get(id);
    if (!w) return;
    w.status = status;
    w.currentJobId = status === 'busy' ? jobId : null;
  }

  /** Fold a real measured throughput sample into the worker's EMA. */
  recordThroughput(id, tokensPerSec) {
    const w = this.workers.get(id);
    if (!w) return;
    w.tokensPerSec = updateEma(w.tokensPerSec, tokensPerSec, this.emaAlpha);
    w.jobsCompleted += 1;
  }

  /** Idle workers that can serve `model` (a null model matches any worker). */
  idleFor(model) {
    const wanted = model ? normalizeModel(model) : null;
    const out = [];
    for (const w of this.workers.values()) {
      if (w.status !== 'idle') continue;
      if (wanted && !w.models.includes(wanted)) continue;
      out.push(w);
    }
    return out;
  }

  /** Weighted-random idle worker for a model, or null if none are free. */
  pickIdle(model, rng = Math.random) {
    return pickWeighted(this.idleFor(model), { floor: this.floor, rng });
  }

  /** Every distinct model currently served by at least one connected worker. */
  modelsAvailable() {
    const set = new Set();
    for (const w of this.workers.values()) for (const m of w.models) set.add(m);
    return [...set];
  }

  size() {
    return this.workers.size;
  }

  idleCount() {
    let n = 0;
    for (const w of this.workers.values()) if (w.status === 'idle') n++;
    return n;
  }

  /** Worker keys currently connected (for periodic uptime heartbeats). */
  keysOnline() {
    const keys = [];
    for (const w of this.workers.values()) if (w.key) keys.push(w.key);
    return keys;
  }

  snapshot() {
    return [...this.workers.values()].map((w) => ({
      id: w.id,
      name: w.name,
      models: w.models,
      tokensPerSec: Math.round(w.tokensPerSec * 10) / 10,
      status: w.status,
      jobsCompleted: w.jobsCompleted,
    }));
  }
}

export function normalizeModel(m) {
  return String(m).trim().toLowerCase();
}
