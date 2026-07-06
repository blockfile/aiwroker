// Standalone verification: does a worker's contribution actually save to MongoDB?
// Spins up a real (in-memory) MongoDB, runs the full flow, checks persistence.
//   node scripts/verify-db.mjs
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io } from 'socket.io-client';
import { createOrchestrator } from '../src/orchestrator/createOrchestrator.js';

const silent = { info() {}, warn() {}, error() {} };
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'; // valid Solana address

console.log('starting in-memory MongoDB (first run downloads a mongod binary)...');
const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();
console.log('mongo up:', uri.split('?')[0]);

const orch = createOrchestrator({ logger: silent, mongoUri: uri, mongoDb: 'core' });
const port = await orch.listen(0);
const base = `http://localhost:${port}`;

// A worker that registers with the wallet as its key and echoes a 2-token reply.
const worker = io(`${base}/workers`, { transports: ['websocket'] });
worker.on('job', ({ jobId }) => {
  worker.emit('token', { jobId, token: 'Hello ' });
  worker.emit('token', { jobId, token: 'world' });
  worker.emit('done', { jobId, tokensPerSec: 12 });
});
const reg = await new Promise((res) =>
  worker.on('connect', () =>
    worker.emit('register', { name: 'DBTest', models: ['mock'], tokensPerSec: 12, key: WALLET }, res),
  ),
);
console.log('worker register ack:', reg);
if (!reg?.ok) {
  console.log('FAIL: registration rejected');
  process.exit(1);
}

// A user sends one chat -> job completes -> contribution recorded.
const user = io(`${base}/users`, { transports: ['websocket'] });
await new Promise((resolve, reject) => {
  user.on('done', () => resolve());
  user.on('failed', (d) => reject(new Error(d.message)));
  user.on('connect', () =>
    user.emit('chat', { model: 'mock', messages: [{ role: 'user', content: 'hi' }] }, (a) => {
      if (!a?.ok) reject(new Error(a?.error));
    }),
  );
});
console.log('job completed; waiting for the async DB write...');
await new Promise((r) => setTimeout(r, 1000));

const rewards = await (await fetch(`${base}/api/rewards`)).json();
console.log('\n/api/rewards ->');
console.log(JSON.stringify(rewards, null, 2));

const w = rewards.rewards?.[0];
const ok =
  rewards.persistence === true &&
  rewards.count === 1 &&
  w &&
  w.totalJobs >= 1 &&
  w.totalTokens >= 2 &&
  typeof w.share === 'number';

console.log(ok ? '\nPASS ✅  contribution saved to MongoDB and shows in /api/rewards' : '\nFAIL ❌');

worker.close();
user.close();
await orch.close();
await mongo.stop();
process.exit(ok ? 0 : 1);
