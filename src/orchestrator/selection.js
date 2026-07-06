// Pure selection + smoothing helpers. No sockets, no side effects — these are
// unit-tested in isolation (test/selection.test.js).

/**
 * Weighted-random pick, biased toward faster workers but never starving slow
 * ones (each worker's weight is at least `floor`). `rng` is injectable so the
 * choice is deterministic in tests.
 *
 * @param {Array<{tokensPerSec?: number}>} workers
 * @param {{ floor?: number, rng?: () => number }} [opts]
 * @returns {*} the chosen worker, or null if the list is empty
 */
export function pickWeighted(workers, { floor = 1, rng = Math.random } = {}) {
  if (!workers || workers.length === 0) return null;
  if (workers.length === 1) return workers[0];

  const weights = workers.map((w) => Math.max(floor, w.tokensPerSec || floor));
  const total = weights.reduce((a, b) => a + b, 0);

  let r = rng() * total;
  for (let i = 0; i < workers.length; i++) {
    r -= weights[i];
    if (r <= 0) return workers[i];
  }
  return workers[workers.length - 1]; // floating-point safety net
}

/**
 * Exponential moving average update for a worker's measured tokens/sec.
 * The first real sample replaces the seed estimate outright.
 */
export function updateEma(previous, sample, alpha = 0.3) {
  if (!Number.isFinite(sample) || sample <= 0) return previous;
  if (!Number.isFinite(previous) || previous <= 0) return sample;
  return alpha * sample + (1 - alpha) * previous;
}
