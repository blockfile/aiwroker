// One-time environment setup so a non-developer can run the worker with a single
// command. Detects Ollama, installs it if missing, starts it, and downloads the
// model — printing friendly progress and clear fallbacks if anything can't be
// automated. Safe to run every time: each step is a no-op once satisfied.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === 'win32';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: isWin });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

async function commandExists(cmd) {
  try {
    await execFileP(isWin ? 'where' : 'which', [cmd], { shell: isWin });
    return true;
  } catch {
    return false;
  }
}

async function ollamaUp(url) {
  try {
    const r = await fetch(`${url}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

function manualInstallHelp() {
  console.log('\n  Please install Ollama once, then run this command again:');
  if (isWin) console.log('    Download: https://ollama.com/download/windows');
  else if (process.platform === 'darwin') console.log('    Download: https://ollama.com/download/mac');
  else console.log('    Run: curl -fsSL https://ollama.com/install.sh | sh');
  console.log('');
}

async function tryInstallOllama() {
  try {
    if (isWin) {
      console.log('Installing Ollama via winget (one-time)…');
      await run('winget', [
        'install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements',
      ]);
    } else if (process.platform === 'darwin') {
      if (!(await commandExists('brew'))) return false;
      console.log('Installing Ollama via Homebrew (one-time)…');
      await run('brew', ['install', 'ollama']);
    } else {
      console.log('Installing Ollama (one-time)…');
      await run('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
    }
    return await commandExists('ollama');
  } catch (err) {
    console.warn(`Auto-install failed: ${err.message}`);
    return false;
  }
}

/**
 * Ensure Ollama is installed, running, and the model is present.
 * @param {{ ollamaUrl: string, model: string, autoInstall?: boolean }} opts
 */
export async function ensureReady({ ollamaUrl, model, autoInstall = true }) {
  // 1) Installed?
  if (!(await commandExists('ollama'))) {
    console.log('Ollama is not installed.');
    const installed = autoInstall && (await tryInstallOllama());
    if (!installed) {
      manualInstallHelp();
      process.exit(1);
    }
  }

  // 2) Running?
  if (!(await ollamaUp(ollamaUrl))) {
    console.log('Starting Ollama…');
    const child = spawn('ollama', ['serve'], { stdio: 'ignore', detached: true, shell: isWin });
    child.unref();
    let up = false;
    for (let i = 0; i < 30; i++) {
      if (await ollamaUp(ollamaUrl)) {
        up = true;
        break;
      }
      await sleep(500);
    }
    if (!up) console.warn('Ollama did not respond yet — continuing; it may still be starting.');
  }

  // 3) Model present?
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`);
    const { models = [] } = await r.json();
    if (models.map((m) => m.name).includes(model)) {
      console.log(`Model "${model}" is ready.`);
      return;
    }
  } catch {
    /* fall through to pull */
  }
  console.log(`Downloading model "${model}" — one-time, this can take a few minutes…`);
  await run('ollama', ['pull', model]);
  console.log(`Model "${model}" downloaded.`);
}
