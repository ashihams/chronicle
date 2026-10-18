# Azure VM deploy (app + watcher-a + Caddy)

Public stable HTTPS for the submission gate. Run **watcher B elsewhere** (second laptop / GitHub Actions) so vantages differ.

## 1. Create the VM

- Image: **Ubuntu Server 24.04 LTS**
- Size: **B2s** (or any ≥2 GB RAM; B1s is tight for image builds)
- Region: Central India / South India if offered
- Auth: SSH key (download `.pem`) or password
- Inbound NSG: **22, 80, 443**
- After create: note **public IP** → set **DNS name label** (e.g. `chronicle-demo`)  
  Hostname: `chronicle-demo.<region>.cloudapp.azure.com`

Optional: restrict port 22 to your IP in Networking.

## 2. Server bootstrap

```bash
ssh -i key.pem azureuser@<public-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/ashihams/chronicle.git chronicle && cd chronicle
# use the branch you submit (e.g. main or stretch-s6)
```

## 3. `.env` on the VM

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Minimum:

```env
ARKIV_MODE=live
SITE_ADDRESS=chronicle-demo.<region>.cloudapp.azure.com
WATCHER_PRIVATE_KEY=0x...          # wallet A only — never B
DEMO_ADMIN_TOKEN=<long random hex>
USER_AGENT=Chronicle/0.1 (owner; you@email.com)
ALLOW_DEMO=0                       # set to 1 only while recording the Change act
# Bind app/demo to localhost only; Caddy owns 80/443
APP_PUBLISH=127.0.0.1:8080
DEMO_PUBLISH=127.0.0.1:4000
WATCHER_A_PUBLISH=127.0.0.1:8081
```

Optional: `GROQ_API_KEY=...`

Do **not** put `WATCHER_B_PRIVATE_KEY` on this VM if B runs elsewhere.

## 4. Start (no watcher-b on this host)

```bash
docker compose --profile https up -d --build demo-site app watcher-a caddy
docker compose logs -f watcher-a
```

`caddy` is behind profile `https`. `watcher-b` is behind profile `watcher-b` (do **not** enable it on this VM).

Open on your phone:

- UI: `https://<SITE_ADDRESS>/`
- Demo (for B / mutations): `https://<SITE_ADDRESS>/demo/circulars/001`

Caddy obtains a Let’s Encrypt cert for the `*.cloudapp.azure.com` name automatically (ports 80/443 must be reachable).

## 5. Watcher B (other network)

On the second machine, generate a watchlist with your public demo base:

```bash
SITE=https://chronicle-demo.<region>.cloudapp.azure.com
sed "s|__SITE__|$SITE|g" deploy/watchlist.azure-b.template.json > watchlist-b.json
```

Then run B with `WATCHER_PRIVATE_KEY` = wallet B, `VANTAGE=eu-vps`, `ALLOW_DEMO=1`, `WATCHLIST_PATH=./watchlist-b.json`.

## 6. After 23 Oct

Deallocate/stop the VM in Azure to stop compute charges. Delete the public IP/NIC if you want zero residual cost.

## Compose / Caddy map

| Service | Role |
|---|---|
| `demo-site` | Synthetic notices (internal + `/demo/*`) |
| `app` | Indexer + UI |
| `watcher-a` | `VANTAGE=in-vps`, key A, watchlist `deploy/watchlist.docker.json` → `http://demo-site:4000` |
| `caddy` | HTTPS on 80/443 → app + `/demo` → demo-site |
| `watcher-b` | Profile only — use another host |
