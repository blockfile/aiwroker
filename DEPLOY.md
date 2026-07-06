# Deploying the orchestrator (Ubuntu droplet)

The droplet runs **only the orchestrator** — no AI, no Ollama. It's a switchboard,
so a small box is fine. CPU workers run on other machines and connect in.

Target: `https://api.blacktroll.meme` → orchestrator on `127.0.0.1:3000`.

---

## 0. Point DNS first (do this before TLS)

At your DNS provider (or DigitalOcean → Networking → Domains), add an **A record**:

```
api.blacktroll.meme   →   <your droplet's public IP>
```

Wait until it resolves (`ping api.blacktroll.meme` shows the droplet IP). certbot
needs this working.

## 1. Connect and update

```bash
ssh root@<droplet-ip>          # or your sudo user
sudo apt update && sudo apt upgrade -y
```

## 2. Install Node.js 22 + git

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v && npm -v             # expect v22.x and 10.x
```

## 3. Install PM2, nginx, certbot

```bash
sudo npm install -g pm2
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 4. Get the code into /var/www

```bash
sudo mkdir -p /var/www
sudo chown -R $USER:$USER /var/www
cd /var/www
git clone https://github.com/blockfile/aiwroker.git aiworker
cd aiworker
```

## 5. Install dependencies

```bash
npm install
```

## 6. Start the orchestrator with PM2

```bash
PORT=3000 BRAND_NAME="BlackTroll" pm2 start src/orchestrator/server.js --name aiworker
pm2 save
pm2 startup      # copy–paste and run the command it prints (sets up auto-start on reboot)
```

Check it's alive locally:

```bash
curl http://localhost:3000/health     # -> {"ok":true,"brand":"BlackTroll"}
pm2 logs aiworker --lines 20
```

## 7. Reverse-proxy with nginx (WebSocket + streaming ready)

```bash
sudo nano /etc/nginx/sites-available/aiworker
```

Paste:

```nginx
server {
    listen 80;
    server_name api.blacktroll.meme;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket upgrade (Socket.IO)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Stream tokens in real time (SSE + Socket.IO), keep long connections open
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

Enable it, drop nginx's default page, and reload:

```bash
sudo ln -s /etc/nginx/sites-available/aiworker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## 9. TLS (HTTPS + WSS)

```bash
sudo certbot --nginx -d api.blacktroll.meme
```

Choose **redirect** (force HTTPS) when asked. Renewal is automatic.

## 10. Test it end to end

```bash
curl https://api.blacktroll.meme/health     # {"ok":true,...}
curl https://api.blacktroll.meme/stats      # workers/models JSON
```

Then connect a worker **from your PC** (not the droplet):

```bash
# from a clone of the repo:
node src/workers/native-worker.js --url https://api.blacktroll.meme --model qwen2.5:1.5b
# or, once published to npm:
npx core-ai-worker --url https://api.blacktroll.meme --model qwen2.5:1.5b
```

`curl https://api.blacktroll.meme/stats` should now list your worker + model.

---

## Updating after you push new code

```bash
cd /var/www/aiworker
git pull
npm install
pm2 restart aiworker
```

## Handy PM2 commands

```bash
pm2 status              # is it running?
pm2 logs aiworker       # live logs
pm2 restart aiworker
pm2 stop aiworker
```

## Notes

- The droplet does **no inference** — don't install Ollama here. Workers run it on
  their own machines.
- If you keep the browser worker, its model-weight cache lives in
  `public/models/_cache/` and can grow to a few GB — watch disk with `df -h`.
- CORS is currently `*`. Once your frontend has a real domain, set
  `corsOrigin` to it for tighter security.
