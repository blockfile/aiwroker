// Runnable entry point for the orchestrator.
//   node src/orchestrator/server.js
//   node --env-file=.env src/orchestrator/server.js   (to load .env)

import { createOrchestrator } from './createOrchestrator.js';
import { config } from './config.js';

const orchestrator = createOrchestrator();

orchestrator.listen(config.port).then((port) => {
  console.log('');
  console.log('  AIworker orchestrator is up.');
  console.log(`  Stats:   http://localhost:${port}/stats`);
  console.log(`  Workers connect to:  ws://localhost:${port}/workers`);
  console.log(`  Users   connect to:  ws://localhost:${port}/users`);
  console.log('');
  console.log('  Next: start a worker in another terminal:');
  console.log('    npm run worker:mock     (no model needed — canned replies)');
  console.log('    npm run worker          (real inference via local Ollama)');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, shutting down...`);
    await orchestrator.close();
    process.exit(0);
  });
}
