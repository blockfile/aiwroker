// Live web-search test: real worker + real Ollama + a STUB search function.
// Asks something the model can't know; if it calls web_search and uses the
// (fake) result, the answer will contain the stub data.
//   node scripts/verify-search.mjs [model]
import { spawn } from 'node:child_process';
import { createOrchestrator } from '../src/orchestrator/createOrchestrator.js';

const MODEL = process.argv[2] || 'qwen2.5:1.5b';
const MARKER = 'the BlackTroll network launched with exactly 4242 nodes on July 7, 2026';
const stubSearch = async (q) => {
  console.log(`\n>>> [orchestrator] web_search("${q}") -> returning stub result`);
  return `Web results for "${q}":\n[1] Network Launch Report\nhttps://example.com\n${MARKER}.`;
};

const orch = createOrchestrator({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  searchFn: stubSearch,
  firstTokenTimeoutMs: 120000,
  streamStallTimeoutMs: 90000,
});
const port = await orch.listen(0);
const base = `http://localhost:${port}`;
console.log('orchestrator on', base, '| model', MODEL);

const worker = spawn(
  'node',
  ['src/workers/native-worker.js', '--url', base, '--model', MODEL, '--no-setup'],
  { stdio: 'ignore' },
);

const online = async () => {
  try {
    const j = await (await fetch(`${base}/stats`)).json();
    return j.workersOnline >= 1;
  } catch {
    return false;
  }
};
for (let i = 0; i < 40; i++) {
  if (await online()) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('worker online, asking a question it can only answer via search...');

const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          'Use web search to answer: how many nodes did the BlackTroll network launch with, and on what date?',
      },
    ],
  }),
});
const data = await res.json();
const answer = data.choices?.[0]?.message?.content || JSON.stringify(data);
console.log('\nANSWER:\n', answer);

const used = /4242/.test(answer);
console.log(
  used
    ? '\nPASS ✅  the model called web_search and used the result'
    : '\nNOTE: the model did not use the search result (small models are inconsistent at tool calls; try a bigger model)',
);

worker.kill();
await orch.close();
process.exit(used ? 0 : 2);
