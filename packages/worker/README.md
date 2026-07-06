# blacktroll-worker

Lend your CPU to the **BlackTroll** network and help run AI for everyone — no
clone, no config, no GPU required.

## Run it

```bash
npx blacktroll-worker
```

That's it. On first run it automatically installs [Ollama](https://ollama.com),
downloads a small model, and connects to the network. Leave the terminal open —
your CPU is now a worker.

**Requires:** [Node.js](https://nodejs.org) 20+ (a normal, signed installer).

## Options

```bash
# weak/old PC — smaller model, cap CPU cores so your machine stays responsive
npx blacktroll-worker --model qwen2.5:0.5b --threads 2

# stronger PC — bigger, smarter model
npx blacktroll-worker --model qwen2.5:7b

# point at a different network
npx blacktroll-worker --url https://api.blacktroll.meme
```

Run `npx blacktroll-worker --help` for all flags.

## How it works

Your machine opens an outbound websocket to the network's orchestrator (so no
firewall or port setup is needed), registers the model it can serve, and waits.
When someone sends a prompt, the orchestrator routes it to your worker, your CPU
generates the answer via Ollama, and the tokens stream back. The orchestrator
stores nothing and never learns who the user is.
