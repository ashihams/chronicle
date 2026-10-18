# Chronicle

Shared, tamper-evident **evidence registry** for public records that change (government circulars, notices, PDFs). Independent watchers fetch sources, hash and classify what they see, and write **observations** to [Arkiv](https://docs.arkiv.network) (Tiramisu testnet). An indexer mirrors the chain, derives versions/flags, and serves a public UI and evidence bundles.

**Hackathon:** Arkiv Global Tour Stop — tracks **Best Indian Use Case** (lead) and **Censorship Resistance**. Build window 9–18 Oct 2026.

Chronicle proves *what was observed, when, by whom* (wallet + vantage label). It does **not** prove authenticity, intent, or that a notice is “real.”

## Architecture

```mermaid
flowchart LR
  subgraph Sources
    S1[Gov web page]
    S2[Gov PDF circular]
    S3[Gov index / listing page]
  end
  subgraph Watchers
    W1[Watcher A - India VPS]
    W2[Watcher B - other network]
    W3[Community watcher - Docker]
  end
  subgraph Arkiv[Arkiv - Tiramisu testnet]
    D[(doc)]
    O[(observation)]
    IS[(index_snapshot)]
  end
  S1 --> W1 & W2 & W3
  S2 --> W1 & W2 & W3
  S3 --> W1 & W2 & W3
  W1 & W2 & W3 -->|createEntity| O
  W1 & W2 & W3 -->|createEntity| D
  W1 & W2 & W3 -->|createEntity| IS
  Arkiv -->|sync + liveness check| IDX[Indexer: SQLite mirror]
  IDX --> DER[Derived: versions, flags]
  DER --> API[REST API]
  Arkiv -->|live attribute queries| API
  API --> UI[Web UI]
  API --> BOT[Telegram bot: verifier]
  API --> EXP[Evidence bundle]
  EXP --> CLI[chronicle verify]
  CLI -. re-fetches entities .-> Arkiv
  BOT --- SUBS[(bot.db: off-chain subscriptions, stretch)]
```

## Quick start (fake mode)

Three commands from a clean clone (Node 20+, pnpm 9, [poppler](https://poppler.freedesktop.org/) for PDFs):

```bash
pnpm install
pnpm build
pnpm dev:fake
```

Then open http://localhost:8080 (UI + API). Demo site: http://localhost:4000 (admin token from `.env.example`, default `change-me`).

`pnpm dev:fake` runs demo site + watcher + indexer in **one process** on one in-memory Arkiv chain. Restarting clears the chain.

Seed the demo sequence (deadline edit → soft remove → restore) with two synthetic wallets:

```bash
pnpm seed:demo
```

## Live mode setup (required for submission)

Compose and `.env.example` default to **`ARKIV_MODE=live`**. Fake mode is only for single-process host demos (`pnpm dev:fake`) and CI.

1. Copy `.env.example` → `.env` (never commit `.env`).
2. Fund **two** Tiramisu wallets (faucet via [hub.arkiv.network](https://hub.arkiv.network) / [docs.arkiv.network](https://docs.arkiv.network)).
3. Set `WATCHER_PRIVATE_KEY` (watcher-a / `in-vps`) and `WATCHER_B_PRIVATE_KEY` (watcher-b / `eu-vps`).
4. Optional: `GROQ_API_KEY` for LLM + Tamil/Hindi summaries.
5. `docker compose up --build` — demo + app + watcher-a (live Arkiv). On Windows, if `localhost:8080` is stolen, use `PORT=8090` for host runs.
6. **Public HTTPS (recommended):** Azure VM + Caddy — follow [`deploy/AZURE.md`](deploy/AZURE.md). Watcher B runs on a **different** network (second laptop / Actions), not on that VM.


```bash
pnpm dev:demo
pnpm dev:watcher          # add -- --once for a single pass
pnpm dev:indexer
```

Wallet addresses: [`arkiv/schema.md`](arkiv/schema.md). Watchlist includes **real** `.gov.in` listing pages plus synthetic demos (demos need `ALLOW_DEMO=1` under `NODE_ENV=production`). Controlled demo mutations with live keys also land on Arkiv — that is intentional for the video, not a fake chain.

### Public deployment (Azure + Caddy)

Full steps: [`deploy/AZURE.md`](deploy/AZURE.md).

```bash
# on the VM, after .env has SITE_ADDRESS + WATCHER_PRIVATE_KEY (A) + strong DEMO_ADMIN_TOKEN:
docker compose --profile https up -d --build demo-site app watcher-a caddy
```

- UI: `https://$SITE_ADDRESS/`
- Demo (for B): `https://$SITE_ADDRESS/demo/circulars/…`
- B watchlist template: [`deploy/watchlist.azure-b.template.json`](deploy/watchlist.azure-b.template.json) (`sed` replace `__SITE__`)

### Fallback: Cloudflare quick tunnel (laptop only)

Unstable for the “public stable HTTPS” gate; use only if Azure is blocked. Do not restart `cloudflared` after submitting the URL. Keep a video as primary evidence.

#### Watcher B (second laptop / other network)

Different network than the Azure VM. Wallet B key only. `ALLOW_DEMO=1` while recording. Watchlist from the azure-b template (or temporary tunnel URLs).

## Reproduce the demo

1. `pnpm seed:demo` or manually: start `dev:fake`, open demo admin, `edit_deadline` on notice 001, wait for the watcher, then soft-remove / restore.
2. UI: home list → doc timeline (versions, flags, creators) → Verify page (`/api/match`) → Watchers.
3. Download evidence bundle from the doc page (`/api/bundle/:docId`).
4. `pnpm --filter @chronicle/cli exec chronicle verify <bundle.json>`.

## Run a community watcher

Anyone can add an independent vantage with one Docker command. Use a **funded** Tiramisu testnet key that is **not** the same wallet as the VPS watchers.

```
docker run --rm \
  -e WATCHER_PRIVATE_KEY=0xYOUR_FUNDED_TESTNET_KEY \
  -e VANTAGE=community-yourname \
  -e WATCHLIST_URL=https://raw.githubusercontent.com/ashihams/chronicle/main/watchlist.json \
  -e ARKIV_MODE=live \
  ghcr.io/ashihams/chronicle-watcher:latest
```

### Faucet

1. Create a fresh wallet (or use one you control).
2. Fund it from the Tiramisu testnet faucet (linked from [hub.arkiv.network](https://hub.arkiv.network) and [docs.arkiv.network](https://docs.arkiv.network)).
3. Set `WATCHER_PRIVATE_KEY` to that key only via the environment (never commit it).
4. Restart the container after funding; a zero balance exits with a clear error.

### Vantage note

A wallet on the **same machine** (or the same residential IP / cloud region) as another Chronicle watcher is **not** an independent vantage. Judges look for distinct networks. Prefer a different host, VPN egress, or region, and set `VANTAGE=community-<yourname>` so the UI can show the label.

### Local compose (app + demo + watcher-a)

```bash
docker compose up --build
```

Requires funded `WATCHER_PRIVATE_KEY` in `.env`. Optional second watcher on this host: `docker compose --profile watcher-b up -d` (needs `WATCHER_B_PRIVATE_KEY`); prefer a **different network** for submission.

- UI: http://localhost:8080  
- Demo site: http://localhost:4000  
- Watcher A health: http://localhost:8081/health (`VANTAGE=in-vps`)  

Set `ALLOW_DEMO=1` only when you need synthetic demo mutations under `NODE_ENV=production`. Real MEA/GISO/HAREDA/DOE/RBI/SEBI/eGazette listing pages are in the watchlist either way.

Public HTTPS: `docker compose --profile https up` with `SITE_ADDRESS` set — see [`deploy/AZURE.md`](deploy/AZURE.md).

For a fake in-memory chain on the host only: `pnpm dev:fake` (do not use compose fake across containers).

## Verify a bundle

```bash
pnpm --filter @chronicle/cli exec chronicle bundle <doc_id> --api http://localhost:8080 --out bundle.json
pnpm --filter @chronicle/cli exec chronicle verify bundle.json
pnpm --filter @chronicle/cli exec chronicle entity <entity_key>
```

`verify` re-fetches each entity from Arkiv (or fake client in tests), checks hashes/creators/blocks, and exits 0 (PASS), 1 (FAIL), or 2 (EXPIRED/DELETED/OWNER_CHANGED per CLI docs).

## Honest limitations

- Testnet expiry (~180 day TTL) and faucet funding.
- Watchers can lie; trust comes from multiple independent creators, not a single operator.
- Normalizer and extractor versions matter; different normalizers produce different hashes.
- Indexer SQLite is a cache — operators can serve a false UI; use `chronicle verify` against the chain.
- Fake mode does not span processes/containers.
- Telegram bot baseline (Stage 6B) and stretch features may be cut before freeze — see `PROGRESS.md`.
- Explorer deep-link formats need HUMAN confirmation (SPA returns 200 for all paths).

## Hackathon gates checklist

- [ ] Public deployment judges can open
- [ ] Reproducible README steps (this file)
- [ ] Public MIT repo
- [ ] [`arkiv/schema.md`](arkiv/schema.md)
- [ ] [`arkiv/friction.md`](arkiv/friction.md)
- [ ] Wallet addresses that create entities listed in schema
- [ ] Demo video ≤ 3 minutes
- [ ] Form questions answered
- [ ] Built 9–18 Oct; baseline in [`BASELINE.md`](BASELINE.md)
- [ ] No private keys / secrets / personal data on Arkiv
- [ ] Deployment up until 23 Oct
- [ ] No history rewrite after deadline
- [ ] Indian-national team member (Best Indian Use Case)

## Baseline

See [`BASELINE.md`](BASELINE.md). Stated baseline: no pre-existing code; first commit is Stage 0 bootstrap (**HUMAN** must confirm before submission).

## Tracks entered

- Best Indian Use Case (lead)
- Censorship Resistance

## License

MIT — see [`LICENSE`](LICENSE).
