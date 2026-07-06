// One-time environment setup so a non-developer can run the worker with a single
// command. Detects Ollama (via its API and common install locations, not just
// PATH), starts it, installs it only if truly absent, and downloads the model.
// Every step is a safe no-op once satisfied.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Use a shell only for bare command names on Windows (so PATH/PATHEXT resolve
// them). For a full path to an .exe, spawn it directly — no shell, so spaces in
// the path are handled correctly.
const needsShell = (cmd) => isWin && !/[\\/]/.test(cmd);

// Can we actually launch this command? Spawns `<cmd> --version` and requires a
// clean exit (code 0). IMPORTANT on Windows: a missing command run via the shell
// doesn't emit ENOENT — cmd.exe prints "not recognized" and exits with code 1 —
// so we must check the exit code, not just that the process ran.
function canRun(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore', shell: needsShell(cmd) });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// Find a usable `ollama` command: PATH first, then the default install paths.
async function resolveOllama() {
  if (await canRun('ollama')) return 'ollama';
  const candidates = [];
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
    candidates.push('C:\\Program Files\\Ollama\\ollama.exe');
  } else {
    candidates.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama');
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function ollamaUp(url) {
  try {
    const r = await fetch(`${url}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

// Run a command and show its output (used for installs / model pulls).
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: needsShell(cmd) });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

function startServer(cmd) {
  try {
    const child = spawn(cmd, ['serve'], { stdio: 'ignore', detached: true, shell: needsShell(cmd) });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}

function manualInstallHelp() {
  console.log('\n  Please install Ollama once, then run this command again:');
  if (isWin) console.log('    Download: https://ollama.com/download/windows');
  else if (process.platform === 'darwin') console.log('    Download: https://ollama.com/download/mac');
  else console.log('    Run: curl -fsSL https://ollama.com/install.sh | sh');
  console.log('');
}

// Best-effort install. Never fatal — winget returns non-zero when Ollama is
// already installed, which is fine; we re-detect afterwards.
async function tryInstallOllama() {
  try {
    if (isWin) {
      console.log('Installing Ollama via winget (one-time)…');
      await run('winget', [
        'install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements',
      ]);
    } else if (process.platform === 'darwin') {
      if (!(await canRun('brew'))) return;
      console.log('Installing Ollama via Homebrew (one-time)…');
      await run('brew', ['install', 'ollama']);
    } else {
      console.log('Installing Ollama (one-time)…');
      await run('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
    }
  } catch (err) {
    console.log(`(installer note: ${err.message} — checking if Ollama is already present)`);
  }
}

async function pullViaApi(url, model) {
  const res = await fetch(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`pull failed (${res.status})`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.error) throw new Error(o.error);
        if (o.status) {
          const pct = o.completed && o.total ? ` ${Math.round((100 * o.completed) / o.total)}%` : '';
          process.stdout.write(`\r  ${o.status}${pct}          `);
        }
      } catch {
        /* ignore partial line */
      }
    }
  }
  process.stdout.write('\n');
}

async function ensureModel(url, cmd, model) {
  try {
    const r = await fetch(`${url}/api/tags`);
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name);
    if (names.includes(model) || names.includes(`${model}:latest`)) {
      console.log(`Model "${model}" is ready.`);
      return;
    }
  } catch {
    /* fall through to pull */
  }
  console.log(`Downloading model "${model}" — one-time, this can take a few minutes…`);
  if (cmd) await run(cmd, ['pull', model]);
  else await pullViaApi(url, model);
  console.log(`Model "${model}" downloaded.`);
}

/**
 * Ensure Ollama is installed, running, and the model is present.
 * @param {{ ollamaUrl: string, model: string, autoInstall?: boolean }} opts
 */
export async function ensureReady({ ollamaUrl, model, autoInstall = true }) {
  // 1) Is Ollama present? (already-running API, or a resolvable command)
  let cmd = await resolveOllama();
  if (!cmd && !(await ollamaUp(ollamaUrl))) {
    if (autoInstall) {
      console.log('Ollama not found — installing it for you (one-time).');
      await tryInstallOllama();
      cmd = await resolveOllama();
    }
    if (!cmd && !(await ollamaUp(ollamaUrl))) {
      manualInstallHelp();
      process.exit(1);
    }
  }

  // 2) Make sure it's running.
  if (await ollamaUp(ollamaUrl)) {
    console.log('Ollama is running.');
  } else {
    console.log('Starting Ollama…');
    if (cmd) startServer(cmd);
    let up = false;
    for (let i = 0; i < 30; i++) {
      if (await ollamaUp(ollamaUrl)) {
        up = true;
        break;
      }
      await sleep(500);
    }
    if (!up) console.warn('Ollama is taking a moment to start — continuing.');
  }

  // 3) Make sure the model is available.
  await ensureModel(ollamaUrl, cmd, model);
}
