# core-ai-worker

Lend your CPU to the **Core AI** network and help run AI for everyone — no clone,
no config, no GPU required.

## Run it

```bash
npx core-ai-worker --key <your-solana-wallet-address>
```

That's it. On first run it automatically installs [Ollama](https://ollama.com),
downloads a small model, and connects to the network. Leave the terminal open —
your CPU is now a worker, and earnings go to the wallet you passed.

**Requires:** [Node.js](https://nodejs.org) 20+ (a normal, signed installer).

## Options

```bash
# weak/old PC — smaller model, cap CPU cores so your machine stays responsive
npx core-ai-worker --key <wallet> --model qwen2.5:0.5b --threads 2

# stronger PC — bigger, smarter model
npx core-ai-worker --key <wallet> --model qwen2.5:7b
```

Run `npx core-ai-worker --help` for all flags. The `--key` is your Solana wallet
address — that's where your earnings go, so it's checked for validity.

## How it works

Your machine opens an outbound websocket to the network's orchestrator (so no
firewall or port setup is needed), registers the model it can serve, and waits.
When someone sends a prompt, the orchestrator routes it to your worker, your CPU
generates the answer via Ollama, and the tokens stream back. The orchestrator
stores nothing and never learns who the user is.
