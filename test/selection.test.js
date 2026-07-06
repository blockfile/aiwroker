import test from 'node:test';
import assert from 'node:assert/strict';

import { pickWeighted, updateEma } from '../src/orchestrator/selection.js';
import { Registry } from '../src/orchestrator/registry.js';

test('pickWeighted returns null for an empty list', () => {
  assert.equal(pickWeighted([]), null);
});

test('pickWeighted honours the weight boundaries deterministically', () => {
  const workers = [{ tokensPerSec: 10 }, { tokensPerSec: 90 }]; // weights 10 / 90
  // r = 0.05 * 100 = 5  -> falls in the first bucket
  assert.equal(pickWeighted(workers, { rng: () => 0.05 }), workers[0]);
  // r = 0.5 * 100 = 50 -> past the first bucket (10), into the second
  assert.equal(pickWeighted(workers, { rng: () => 0.5 }), workers[1]);
});

test('pickWeighted gives slow workers a floor so they are not starved', () => {
  const workers = [{ tokensPerSec: 0 }, { tokensPerSec: 1000 }];
  // With floor=1, weights are 1 / 1000 (total 1001). A tiny roll picks the slow one.
  assert.equal(pickWeighted(workers, { floor: 1, rng: () => 0 }), workers[0]);
});

test('updateEma seeds from the first real sample, then smooths', () => {
  assert.equal(updateEma(0, 20), 20); // no prior estimate -> take the sample
  assert.equal(updateEma(10, 20, 0.5), 15); // 0.5*20 + 0.5*10
  assert.equal(updateEma(10, 0), 10); // ignore a non-positive sample
});

test('Registry filters idle workers by model, case-insensitively', () => {
  const reg = new Registry();
  reg.add('a', { name: 'A', models: ['Qwen2.5:1.5b'], tokensPerSec: 5 });
  reg.add('b', { name: 'B', models: ['mock'], tokensPerSec: 5 });

  assert.equal(reg.idleFor('qwen2.5:1.5b').length, 1);
  assert.equal(reg.idleFor('qwen2.5:1.5b')[0].id, 'a');
  assert.equal(reg.idleFor('mock')[0].id, 'b');
  assert.deepEqual(reg.modelsAvailable().sort(), ['mock', 'qwen2.5:1.5b']);
});

test('Registry excludes busy workers and reflects status changes', () => {
  const reg = new Registry();
  reg.add('a', { name: 'A', models: ['mock'], tokensPerSec: 5 });
  assert.equal(reg.idleCount(), 1);

  reg.setStatus('a', 'busy', 'job-1');
  assert.equal(reg.idleFor('mock').length, 0);
  assert.equal(reg.get('a').currentJobId, 'job-1');

  reg.setStatus('a', 'idle');
  assert.equal(reg.idleFor('mock').length, 1);
  assert.equal(reg.get('a').currentJobId, null);
});

test('Registry.recordThroughput folds samples into the EMA', () => {
  const reg = new Registry({ emaAlpha: 0.5 });
  reg.add('a', { name: 'A', models: ['mock'], tokensPerSec: 10 });
  reg.recordThroughput('a', 20);
  assert.equal(reg.get('a').tokensPerSec, 15); // 0.5*20 + 0.5*10
  assert.equal(reg.get('a').jobsCompleted, 1);
});

test('a null model matches any idle worker', () => {
  const reg = new Registry();
  reg.add('a', { name: 'A', models: ['mock'], tokensPerSec: 5 });
  assert.equal(reg.idleFor(null).length, 1);
});
