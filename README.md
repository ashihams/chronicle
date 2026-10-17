# Chronicle

Shared, tamper-evident evidence registry for public records that change. Built for the Arkiv Global Tour Stop hackathon.

Full docs (architecture, quick start, limitations) land in Stage 9. Until then:

```bash
pnpm install && pnpm build
pnpm dev:fake   # demo site + watcher + indexer on one in-memory chain
```

Live mode and deployment need funded Tiramisu wallets in `.env` (see `.env.example`).

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

- UI: http://localhost:8080
- Demo site: http://localhost:4000
- Watcher health: http://localhost:8081/health

Compose sets `ALLOW_DEMO=1` so the synthetic demo watchlist is allowed under `NODE_ENV=production`. For a real production image without demo entries, omit `ALLOW_DEMO` and point `WATCHLIST_URL` / `WATCHLIST_PATH` at real pages.

Fake mode (`ARKIV_MODE=fake`) is per-process: the watcher and indexer containers do not share an in-memory chain. Use live mode with funded keys for a shared chain across containers, or `pnpm dev:fake` on the host.

## License

MIT
