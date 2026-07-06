// A minimal command-line user client — the stand-in for the future frontend.
// Connects to a running orchestrator, sends one prompt, and prints the streamed
// answer as it arrives.
//   node scripts/chat.js "your question here"
//   MODEL=qwen2.5:1.5b node scripts/chat.js "explain websockets simply"

import { io } from 'socket.io-client';

const ORCH = process.env.ORCH || 'http://localhost:3000';
const MODEL = process.env.MODEL || 'mock';
const prompt = process.argv.slice(2).join(' ') || 'Hello, who are you?';

const socket = io(`${ORCH}/users`, { transports: ['websocket'] });

socket.on('connect', () => {
  console.log(`asking (model: ${MODEL}): "${prompt}"\n`);
  socket.emit('chat', { model: MODEL, messages: [{ role: 'user', content: prompt }] }, (ack) => {
    if (!ack?.ok) {
      console.error('request rejected:', ack?.error);
      socket.close();
      process.exit(1);
    }
  });
});

socket.on('queued', ({ position, workersOnline }) =>
  console.log(`[queued #${position}${workersOnline != null ? `, ${workersOnline} worker(s) online` : ''}]`),
);
socket.on('assigned', ({ worker }) =>
  console.log(`[assigned to ${worker.name} (~${worker.tokensPerSec} tok/s)]\n`),
);
socket.on('restart', ({ reason }) => process.stdout.write(`\n[restarting: ${reason}]\n`));
socket.on('token', ({ token }) => process.stdout.write(token));
socket.on('done', ({ tokenCount, tokensPerSec, workerName }) => {
  console.log(`\n\n[done — ${tokenCount} tokens from ${workerName} @ ${tokensPerSec} tok/s]`);
  socket.close();
  process.exit(0);
});
socket.on('failed', ({ message }) => {
  console.error(`\n[failed] ${message}`);
  socket.close();
  process.exit(1);
});
socket.on('connect_error', (err) => {
  console.error(`could not connect to ${ORCH}: ${err.message}`);
  process.exit(1);
});
