import test from 'node:test';
import assert from 'node:assert/strict';

import { computeRewards } from '../src/orchestrator/rewards.js';

test('computeRewards returns [] for no workers', () => {
  assert.deepEqual(computeRewards([]), []);
});

test('shares sum to ~1 and sort by contribution', () => {
  const workers = [
    { key: 'a', totalTokens: 1000, uptimeSeconds: 3600, tokensPerSec: 20 },
    { key: 'b', totalTokens: 200, uptimeSeconds: 3600, tokensPerSec: 20 },
  ];
  const out = computeRewards(workers);
  const sum = out.reduce((s, w) => s + w.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.02, `shares should sum to ~1, got ${sum}`);
  // Worker A did 5x the tokens, so it should rank first with a bigger share.
  assert.equal(out[0].key, 'a');
  assert.ok(out[0].share > out[1].share);
});

test('task (useful work) outweighs raw device speed', () => {
  // Slow worker that did lots of work vs fast worker that did little.
  const workers = [
    { key: 'grinder', totalTokens: 5000, uptimeSeconds: 100, tokensPerSec: 5 },
    { key: 'speedster', totalTokens: 100, uptimeSeconds: 100, tokensPerSec: 100 },
  ];
  const out = computeRewards(workers);
  assert.equal(out[0].key, 'grinder', 'the worker that did more useful work should earn more');
});

test('accuracy/reputation multipliers apply and default to 1', () => {
  const workers = [
    { key: 'clean', totalTokens: 1000, uptimeSeconds: 100, tokensPerSec: 10 },
    { key: 'flagged', totalTokens: 1000, uptimeSeconds: 100, tokensPerSec: 10, accuracyScore: 0.1 },
  ];
  const out = computeRewards(workers);
  assert.equal(out[0].key, 'clean');
  assert.equal(out[0].scores.accuracy, 1); // default placeholder
  assert.equal(out.find((w) => w.key === 'flagged').scores.accuracy, 0.1);
  assert.ok(out[0].share > out.find((w) => w.key === 'flagged').share);
});
