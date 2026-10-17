# Chronicle progress

## Definition of done

- [x] S0 repo, CI green (local `pnpm install && pnpm build && pnpm lint && pnpm test` pass; CI runs once a GitHub remote is added)
- [x] S1 wrapper, fake client, probe results, friction entries
- [x] S2 core domain, tests >= 85 percent
- [x] S3 demo site with admin mutations
- [x] S4 watcher, writes to fake and live Arkiv
- [x] S5 indexer, derived data, API, live attribute-query endpoints
- [x] S6 web UI + /api/match
- [ ] S6B Telegram bot baseline
- [x] S7 evidence bundle + CLI verify
- [x] S8 Docker, compose, community watcher instructions
- [x] S9 schema.md, friction.md, README, privacy tests, seed demo
- [ ] Two distinct funded wallets, two networks, observations on live Tiramisu
- [ ] 10-20 real public pages watched since 14 Oct (HUMAN)
- [ ] Deployment public and stable
- [ ] Demo video <= 3 minutes (Stage 10 HUMAN)
- [ ] Form submitted, SHA recorded (Stage 10 HUMAN)
- [ ] Stretch items attempted only after core, cut at 17 Oct 12:00 IST

## Stretch

- [x] S1 contradictions
- [x] S2 stealth-removal
- [x] S3 PDF signature checks
- [x] S4 follow-and-alert
- [x] S5 verifier extras
- [x] S6 Tamil/Hindi

## Decisions and notes

### Stage 0

- The repo lives at the workspace root (`D:\project\arkiv`) rather than a nested `chronicle/` folder.
- Packages export `dist/` for runtime and TypeScript; vitest aliases `@chronicle/*` to `src/` so tests do not need a prior build.
- ESLint 8 is pinned because the spec asks for `.eslintrc.cjs` (legacy config format).
- The config loader validates every known variable and fails fast on invalid values. Variables that only some processes need (for example `WATCHER_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`) are enforced per process through `loadConfig(env, { require: [...] })`. Unknown variables cannot be rejected because `process.env` always contains unrelated system variables.
- Extra dev dependency: `eslint-config-prettier` (turns off ESLint rules that conflict with prettier).

### Stage 1

- Arkiv SDK pinned to `@arkiv-network/sdk ~0.8.1`. Extra dependency: `viem` (a required peer dependency of the SDK; the wrapper also uses `defineChain`, `http`/`webSocket` transports and `getLogs` from it). It is only imported inside `packages/core/src/arkiv/`.
- All SDK imports go through `packages/core/src/arkiv/sdk.ts`; no other file in the repo imports the SDK.
- `pnpm probe` runs `scripts/arkiv-probe.ts` against live Tiramisu (wallet A = `WATCHER_PRIVATE_KEY`, wallet B = `PROBE_SECOND_PRIVATE_KEY`, both in `.env` only). `--only=e05,e06` reruns a subset and merges into `arkiv/probe-results.json`. Final run: 14/14 experiments ok, about 0.0166 testnet GLM spent.
- Interface changes from the spec, forced by what the SDK and node support:
  - `WhereOp` has `prefix` (STARTSWITH) instead of `glob`; there is no glob or pattern operator.
  - `orderBy` removed: the node returns results in no useful order (probe saw 5,3,2,1,4 for creation order 1..5). Sorting happens client-side or in the indexer mirror.
  - Range operators (`gt/gte/lt/lte`) only work on numbers; string ranges are rejected by the node.
  - Added `createdEvents(fromBlock, toBlock)` (EntityCreated logs) for indexer sync.
  - `address()` returns `null` for a read-only client.
  - Entities have no tx hash; `getEntity` fills it from the `EntityCreated` log in the creation block (one extra `eth_getLogs` per read).
  - Addresses and entity keys are lowercased everywhere.
- Limits that change the Stage 2 data model:
  - 32 cells per entity, minus `$payload` and `$contentType`, leaves 30 user attributes.
  - `str` values are at most 128 UTF-8 bytes and may not be empty. Long values (full `source_url`, long `pdf_producer`) go in the payload; attributes hold a truncated or hashed form.
  - Every number is written as `u64` (non-negative safe integers only). A bare number in the SDK is `i32`, and a type mismatch silently matches nothing.
  - Payload limit is 128 KB in the SDK; 120 KB was the largest size tried that the node accepted (129 KB is rejected client-side). Gas grows with payload size (1 KB about 111k gas, 64 KB about 2.66M).
  - Lifetimes must be a multiple of 2 seconds (block time); `ttlToBlocks` rounds up. `extendEntity` sets a new expiry counted from now and fails if that is not later than the current one.
- Sync strategy for the indexer: `block`. Page `EntityCreated` logs from the Arkiv processor address (`0x4400…0044`) in windows of at most 10,000 blocks (50,000 is rejected), then fetch each entity. Raw `$createdAt >= u64(N)` queries also work on the node, but the SDK refuses to build them, so they are a fallback only.
- Writes: about 6 s per sequential create (20 creates took 121 s); a batch of 20 took 7.8 s. The watcher should batch writes per sweep.
- Expired or deleted entities disappear from `getEntity` and `query` but are still visible through `query` with an `atBlock` before the expiry.
- Subscriptions work over both HTTP polling and WebSocket.
- Permissions: only the owner can patch, extend, delete or transfer. After a transfer the creator stays the same and the former owner is rejected with a clear "owned by" error.
- HUMAN:
  - Done 16 Oct: wallet B (`0x11d34e55Bf7c8FC75FdA5d073653D4B0768d817c`) funded and `e08` rerun. A funded non-owner now gets a clear `owned by <owner>, not <caller>` error for patch, extend, delete and transfer. After a transfer the new owner can patch, and `$creator` stays the original writer. (An unfunded caller gets "Execution error without revert data".)
  - Open the explorer and confirm the link formats for transactions, entities and addresses; every path returns 200 because it is a single-page app.

### Stage 2

- New dependencies (all listed in CURSOR_SPEC.md): `cheerio`, `diff` (jsdiff 9), and `pdf-lib` (dev, for synthetic test PDFs). Extra dev dependency not in the spec: `@vitest/coverage-v8`, needed to measure the 85 percent coverage requirement. `pnpm coverage` runs it, and CI enforces the threshold.
- Poppler for local development on Windows: the portable build from github.com/oschwartz10612/poppler-windows, unpacked to `%USERPROFILE%\tools\poppler` and added to the user PATH. PDF tests skip locally when poppler is missing, but never in CI (`CI=true`).
- Data model changes from the Stage 1 limits are in CURSOR_SPEC.md section 5 and `arkiv/schema.md`: `doc.source_url` is an attribute only when the canonical URL is at most 128 bytes, and the doc payload always has `source_url`.
- Choices where the spec was silent or would misfire:
  - URL canonicalization keeps the raw encoding of query pairs and sorts by key with a stable sort, so repeated keys keep their order. Credentials and non-http(s) schemes are rejected.
  - HTML extraction adds a line break after block elements, so `last updated[^.\n]*` cannot swallow the next paragraph. The noise class `ad-` only matches at the start of a class token or after `-`/`_`; the spec's plain substring would drop `download-link` and `lead-in`.
  - Classification: any other non-2xx status (401, 403, 429, an unfollowed 3xx) is `unreachable`, because it says nothing about the document. Soft-removal phrases only count on pages of at most 1000 normalized characters, so a long notice mentioning "withdrawn" is not marked removed. For PDFs the 200-character rule is replaced by the PDF rules (no PDF header, or the text layer disappeared), so scanned PDFs are not soft-removed.
  - PDF text under 50 characters means "scanned"; `normSha256` is then the raw-bytes hash. A file poppler cannot read is treated the same way; only a missing poppler binary throws.
  - LLM provider: Groq instead of Anthropic (owner's request, 16 Oct). `GroqLlmClient` calls the OpenAI-compatible chat completions endpoint with plain `fetch` (no SDK dependency) and strict structured outputs (`response_format: { type: "json_schema", json_schema: { strict: true } }`). Default model `openai/gpt-oss-120b`, one of the models Groq lists for strict mode. Environment variables `GROQ_API_KEY` and `GROQ_MODEL` replace `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. `@anthropic-ai/sdk` was removed.
  - Extraction: Zod is strict on types, `summary_en` and `severity`; invalid dates, slugs and negative amounts become null instead of failing the whole extraction. Dates before 1970 become null because timestamps are u64.
  - `changes` in the observation payload: a `text` change carries the previous and new normalized hashes, never text; amounts are rupee strings with two decimals; removals record `{ field: "removed", from: <previous state>, to: <state> }`.
- Coverage of `packages/core`: 90.7 percent lines (267 tests). `src/arkiv/live.ts` is the only low file (34 percent) because it needs the live network; the probe exercises it.

### Stage 3

- `packages/demo-site`: Fastify 4 app (`buildDemoApp`) with in-memory state, run by `pnpm dev:demo` (`src/server.ts`, which reads the repo `.env` if present). Dependencies: `fastify`, `pdf-lib`, `zod` (all in the spec).
- Every page and PDF says it is synthetic: a top banner and a labeled paragraph inside `<main>` (so the label also survives normalization), a footer line, a synthetic PDF title and banner, and an `x-demo-notice` response header.
- Volatile fields on purpose: `Last updated` (IST clock time, written without periods so the normalizer's `last updated[^.\n]*` pattern covers it) and a visitor counter that increments on every request, both inside `<main>` and in the footer. Tests check that the HTML changes on every request while the normalized hash does not.
- PDFs are rebuilt on each request but are byte-identical for the same state: CreationDate is the printed date (00:00 IST), ModDate is the last content change, and the producer is `Chronicle Demo`. The layout and date style (`30/10/2026`) differ from the HTML. Text is limited to WinAnsi characters because only the standard fonts are used.
- Choices where the spec was open:
  - `edit_text` replaces clause 1 (eligibility).
  - `backdate` without a value moves the printed date back 45 days (more than `BACKDATE_DAYS = 7`).
  - `restore` undoes removal, redirect, delisting and vantage hiding but keeps content edits (edit the fields back to demonstrate a revert). `POST /admin/reset` restores the seed state.
  - Removal and redirect states apply to both the HTML and PDF URLs. A soft-removed PDF URL returns an HTML "no longer available" page with status 200, which core classifies as `soft_removed` (not a PDF).
  - `delist` only hides the notice from the index. The index lists every notice that is not delisted, including removed ones (a broken link, as on real sites).
  - Only content edits (deadline, amount, text, backdate) change `Last-Modified`.
  - The admin token is compared in constant time; the panel never contains it. Non-JSON request bodies are ignored, so a bare `POST /admin/reset` works from any client.
- Integration tests use Fastify `inject` and check each mutation with the real core normalizer and classifier (`changed`, `removed_404`, `removed_410`, `soft_removed`). The PDF text checks run against poppler.

### Stage 4

- `packages/watcher`: `pnpm --filter watcher start -- --once` runs one pass and exits (non-zero if any check errored); without `--once` it schedules every source and serves `GET /health` on `WATCHER_HEALTH_PORT` (8081, added to the env list in the spec and `.env.example`). Dependencies `better-sqlite3`, `robots-parser`, `pino` and `zod` are in the spec; `@types/better-sqlite3` is a dev dependency for its typings, and `@chronicle/demo-site` is a dev dependency for the integration test.
- `watchlist.json` (repo root) has the three synthetic demo notices (page and PDF each, `poll_hours: 1`) and 12 disabled placeholders with `"url": "TODO"` for real pages. The zod schema rejects `TODO` or non-http URLs on enabled items, duplicate notice ids, the same URL twice, and unknown `index_id`s. The demo index links now carry `class="notice-link"` to match `link_selector`.
- Relative `WATCHLIST_PATH` and `DATA_DIR` are resolved against the repo root, so `pnpm --filter watcher ...` (which runs inside `packages/watcher`) uses `./watchlist.json` and `./data` at the root. The local DB is `DATA_DIR/watcher.db`: the section 6 `sources` table plus `last_text_extracted` (the classifier needs it to spot a PDF that lost its text layer) and a `meta` table for the last renewal time.
- Core changes (bug fixes needed by the acceptance flow):
  - Classification: a redirect from a notice to a parent path of it (for example `/circulars/001` to `/circulars/`, which is what the demo and many real sites do) is `redirected`. A redirect to a child path such as an annexure is not.
  - `heuristicExtract` (`rules-v1`): deadline, printed date, amount and "supersedes" found with simple patterns. It is used when `GROQ_API_KEY` is not set, when the text is empty (scanned PDF), or when the LLM fails twice, so the acceptance flow (`deadline_ts` updated, severity at least 2) works without an LLM key.
- Choices where the spec was open:
  - Severity is the rule severity (deadline or amount change = 2, removal = 3), raised by the LLM's severity only for `changed`. On `first_seen` the LLM severity is ignored, so a new notice is never "severity 3".
  - A `present` observation is written right away when the last written state was a removal or `unreachable` (the notice came back), not only after `HEARTBEAT_HOURS`.
  - The "no identical consecutive removal within `HEARTBEAT_HOURS`" rule also applies to `unreachable`.
  - `present` heartbeats repeat the last extracted fields (`deadline_ts`, `amount_paise`, ...) because they describe the same content hash. Removal and `unreachable` observations carry no content fields or hashes.
  - Summaries without an LLM are built from the state and extracted fields only (for example "Deadline changed from 2026-10-30 to 2026-11-20."), never from document text.
  - Backoff (1, 5, 30 minutes) applies to a check that threw (for example an Arkiv write failure or missing poppler) and to the first failure that the failure rule holds back, so `unreachable` is confirmed quickly. A failed write leaves local state untouched, so the next check retries the same observation.
  - robots.txt: 2xx is parsed, 4xx allows everything, 5xx or a network error blocks the host for an hour. Concurrent checks on one host share a single robots.txt fetch. Redirects are followed manually with one overall `FETCH_TIMEOUT_MS`.
  - Doc registration takes any writer's existing `doc` for the `doc_id` (earliest block wins), as the spec says the indexer deduplicates; renewal only extends entities this wallet owns.
  - `ARKIV_MODE=fake` keeps entities in the process's memory, so across separate `--once` runs only the local DB persists. That is enough for the acceptance flow: later runs reuse the cached doc key and compare against the stored hash.
- Verified on 16 Oct with the CLI against the running demo site in fake mode: the first run wrote 6 docs and 6 `first_seen`; the second wrote nothing; `edit_deadline` gave `changed` with severity 2 (page and PDF); `remove_404` gave `removed_404`, `soft_remove` gave `soft_removed`, `redirect` gave `redirected`; a repeat run wrote nothing.
- Writes go through `serializeWrites`, so one wallet sends one transaction at a time (concurrent sends from one account can race on the nonce); reads stay concurrent.
- Live Tiramisu run on 16 Oct (owner's request), wallet A `0x34ccbad283b69a61bd8dd01b97fe6c27377524fe`, vantage `in-vps`, demo site on localhost, default 5 s per-host delay:
  - A first pass hit a stale demo server left over from the fake-mode check, so it registered the 6 docs and wrote `removed_404` (001), `soft_removed` (002) and `redirected` (003) for page and PDF. Those entities are accurate records of what that server returned.
  - With a fresh demo server: 6 `first_seen` (57 s), then a repeat pass with no writes, then `edit_deadline` on 001 gave `changed` with severity 2 for page and PDF. Reading `0xa26253a4…` back from the chain shows `deadline_date` 2026-11-20, the rule summary "Deadline changed from 2026-10-30 to 2026-11-20." and one `doc` for the `doc_id`.
  - 20 writes cost about 0.003 testnet GLM.
- HUMAN: pick the real pages for the watchlist (check robots.txt and terms, fill the URLs, set `enabled: true`).

### Stage 5

- `packages/indexer`: `pnpm dev:indexer` (or `start`) runs the API on `PORT` with a read-only Arkiv client (no private key), a sync loop every `SYNC_INTERVAL_SECONDS`, and a liveness loop every `LIVENESS_INTERVAL_MINUTES`. Runs of one loop never overlap. Dependencies `better-sqlite3`, `fastify`, `pino` and `zod` are in the spec. `@types/better-sqlite3` is a dev dependency for its typings, and `@chronicle/demo-site` and `@chronicle/watcher` are dev dependencies for the integration test and the dev script. CORS, the 60 per minute per-IP rate limit (on `/api/*` only, so the web build's assets are not counted) and static serving are a few lines in `http-util.ts`, so no Fastify plugins were added.
- Sync strategy: `observed_at_window`, not `block`. On Tiramisu about 1.8 entities are created per block by all users, so looking up every created entity is too slow. Each sync queries all `type=doc` and `type=index_snapshot`, plus `type=observation AND observed_at >= last_observed_at - 86400`. A full observation query runs on the first sync and then hourly, to catch watchers whose `observed_at` is far off. Only keys not seen before are fetched in full (`getEntity`, which also returns the creation tx hash). Attributes are validated with zod before the fetch; entities that fail (other projects on the shared chain can use `type=observation` too) go into an `ignored_keys` table and are not fetched again. If the client supports `subscribe`, an event only triggers an early sync, and polling stays the source of truth.
- SQLite schema: the section 6 tables plus cached per-doc columns on `docs` (`current_state`, `current_seq`, `last_seen_ts`, `last_change_ts`, used by the list filters `state` and `changed_since`) and the `ignored_keys` table. Everything is recomputed from the mirror.
- Derivation (`derive.ts`, pure functions) follows 5.3, with these readings of the spec:
  - Only `live` or `expired` content observations count. A `deleted` or `modified` entity drops out of the version chain at the next recompute.
  - Versions are kept per `normalizer_version`. Flags and the doc status use the normalizer version of the newest accepted observation.
  - Current version: each creator's latest observation within 24 hours votes; a removal does not vote; with no votes, the hash of the newest accepted observation is current.
  - Backdating: a printed date only counts when it differs from the previous version's printed date; otherwise every amendment that keeps the original date would be flagged. `last_modified_ts` counts as is. `seq = 1` is never flagged.
  - Vantage disagreement compares content observations only within the same normalizer version. A removal state against a content state also counts; `unreachable` does not.
  - Flags are reconciled per kind: same kind and same entity keys means the same flag (updated in place), and one that no longer applies gets `resolved_ts`. `missing` and `owner_modified` come from the liveness job and stay open.
- Liveness: `getEntity` returns null both for expired and deleted entities. The indexer compares the mirrored `expires_block` (updated on each check, so renewals are followed) with the current block. An attribute or payload hash that differs from the mirror gives `modified` plus `owner_modified` (severity 3), and an owner change only updates `owner`.
- API (section 7): responses use snake_case field names, except `/api/health`, which keeps the spec's `{ok, lastSyncTs, entityCount, chainHead}` (plus `lastLivenessTs`). Errors are `{error, code}` with codes `bad_request`, `not_found`, `rate_limited`, `arkiv_unavailable` (502) and `internal`. The `/api/arkiv/*` endpoints call `ArkivClient.query` on each request and return `source: "arkiv-live"`, the exact `where` (and `creator`), `block_number` and a cursor. They skip entities whose attributes fail validation and report how many as `ignored_invalid`. For `field=deadline|amount`, the query adds `deadline_ts >= 0` or `amount_paise >= 0`, then keeps only observations whose payload `changes` list that field; this is reported as `post_filter`. Timeline events have `kind` `observation`, `version` or `flag`; flag events carry the flag's kind as `flag_kind`.
- Core changes (bug fixes, as the stage allows):
  - `FakeArkivNetwork` takes an optional `clock`, so the head advances with time and block timestamps follow it. `ARKIV_MODE=fake` uses the wall clock. Without this, fake chain time drifted away from the watcher's `observed_at`, and every observation would have been flagged `clock_skew`.
- `ARKIV_MODE=fake` chains live in one process, so `pnpm dev:fake` (after `pnpm build`) runs the demo site, one watcher and the indexer API on one in-memory chain. Verified on 16 Oct with `PORT=8090`, because a Windows system service holds 8080 on this machine: 6 docs, 12 mirrored entities, timeline with a version boundary, `/api/arkiv/changes` returned `source: "arkiv-live"`, and `/api/entities/:key` gave `matches_mirror: true`. The change flow (two watchers, `edit_deadline`, `vantage_disagreement`, live changes query) is covered by the in-process integration test.
- HUMAN: confirm the explorer link formats (`/entity/<key>`, `/tx/<hash>`, `/address/<addr>`). The explorer is a single-page app that answers 200 for any path, so they could not be checked automatically.

### Stage 6

- `POST /api/match` in the indexer: JSON `{ text }` or multipart `file` (PDF, max `BOT_MAX_FILE_MB`). Text is normalized with `normalizeText` / `normHash`; PDFs go through `normalizePdf` (and `raw_sha256` for byte-identical matches). Lookup is against mirrored `versions` by `norm_sha256`, plus observations that recorded the same `raw_sha256`. Response shape matches the Stage 6 note (exact / no match, plain-language `note`). The request body is never logged or written to SQLite. Poppler may use a deleted temp file for PDF text extraction (same as the watcher); that is called out on the Verify page.
- New dependency: `@fastify/multipart` (needed for the multipart upload path; not listed in the stack table, added for Stage 6 only).
- `packages/web`: Vite + React 18 + Tailwind + React Router + TanStack Query. Pages: Home, Doc (versions, flags, timeline), Verify, Watchers, About. Footer disclaimer as specified. Smoke tests with a stubbed `fetch` cover home, timeline, and verify exact/no match.
- UI design: owner-supplied **Bitcoin DeFi** system (true void `#030304`, surface `#0F1115`, Bitcoin orange `#F7931A` / burnt `#EA580C` / gold `#FFD600`, Space Grotesk + Inter + JetBrains Mono, pill CTAs, glass panels, grid fade, orange glow shadows, blockchain-style timeline). Dark-only (overrides the spec's `prefers-color-scheme` dual theme for this stage). No `lucide-react` / `cva` — tokens and component classes live in `tailwind.config.js` + `styles.css` so the stack stays as listed. Flag copy never uses "fraud" or "fake".
- Evidence bundle download button points at `/api/bundle/:docId` (implemented in Stage 7).

### Stage 7

- Evidence bundle (`bundle_version: 1`) schema, `sealBundle` / `parseAndCheckBundle` / `computeBundleSha256` live in `@chronicle/core` so the indexer and CLI share one hash. Canonical JSON is the existing `sha256Of` (sorted keys).
- `GET /api/bundle/:docId` builds from the mirror (`buildEvidenceBundle`): doc metadata, versions, open flags, and every mirrored entity for the doc (doc + observations) ordered by `(creation_block, entity_key)`. Response is downloadable JSON with `bundle_sha256`.
- `packages/cli` (`chronicle` bin via commander): `bundle <doc_id> [--api] [--out]`, `verify <file> [--rpc]`, `entity <key> [--rpc]`. Verify recomputes the hash, re-fetches each entry through `ArkivClient`, checks creator/owner/block/expiry/attributes/payload_sha256/tx (via `getEntity` tx hash or `createdEvents` in the creation block). States: PASS, FAIL, EXPIRED, DELETED, OWNER_CHANGED. Exit 0 / 1 / 2 as specified. Disclaimer printed at the end.
- FakeArkivNetwork now keeps a `creationLog` that survives `__delete`, matching live `EntityCreated` logs so DELETED/EXPIRED verification can still prove the creating tx (Stage 1 probe e10).
- New dependency: `commander` (listed in the stack table).

### Stage 8

- Docker images (build from repo root):
  - `packages/watcher/Dockerfile` — community watcher (`node:20-slim`, poppler-utils, `pnpm deploy --prod --legacy`, uid 10001, `HEALTHCHECK` on `/health`, `ENTRYPOINT node dist/main.js`).
  - `Dockerfile.app` — indexer + built web (poppler for `/api/match`); optional bot sources copied for a later entrypoint.
  - `packages/demo-site/Dockerfile` — synthetic demo site on port 4000.
- `docker-compose.yml`: `demo-site` (:4000), `app` (:8080), `watcher-a` (vantage `in-vps`, `ALLOW_DEMO=1` by default), optional `bot` profile (placeholder until Stage 6B). Watcher mounts `deploy/watchlist.docker.json` (demo URLs use `http://demo-site:4000`). Fake mode remains per-process across containers.
- Production guard: with `NODE_ENV=production` and without `ALLOW_DEMO=1`, the watcher refuses enabled sources whose `notice_id` starts with `demo-` or whose `department` starts with `demo-dept`.
- README section "Run a community watcher" with the exact `docker run` block (`ghcr.io/ashihams/chronicle-watcher:latest`), faucet steps, and same-machine vantage note.
- GHCR: `.github/workflows/ghcr-watcher.yml` builds/pushes the watcher image on tags `v*` and `watcher-*`.
- `ALLOW_DEMO` documented in `.env.example`.
- HUMAN (unchanged): provision VPS 1 (India) for app + watcher-a, VPS 2 for watcher-b, domain + Caddy to 8080; keep up until 23 Oct.
- Docker acceptance on this Windows host (16 Oct): `docker compose build` failed with Docker Desktop engine **read-only file system** / I/O errors while committing layers (daemon disk unhealthy). Images and compose files are in place; re-run `docker compose up --build` after repairing Docker Desktop (Settings → Troubleshoot → Clean / Restart, or reset the disk image), then log image size and cold-start time here:
  - watcher image size: _(pending local docker)_
  - app image size: _(pending local docker)_
  - compose cold start to UI on :8080: _(pending local docker)_

### Stage 9

- Filled `arkiv/schema.md` (overview, entities, time semantics, attribute query table, off-Arkiv data, expiry/probe limits, trust model, wallet list placeholders, recomputable derived data).
- Consolidated `arkiv/friction.md` with Stage 1 probe entries plus development notes (fake chain per-process; tx hash workaround).
- Full `README.md`: what/why, Appendix A Mermaid, fake quick start (3 commands), live setup, reproduce demo, community watcher (exact docker block), bundle verify, limitations, gates checklist, baseline, tracks, MIT.
- Privacy test (`packages/indexer/test/privacy.test.ts`): fake watcher run, scan all doc/observation attrs+payloads for phones/emails/`chat` and demo body markers.
- Match no-persistence test: `/api/match` leaves SQLite bytes unchanged; `normalizePdf` deletes `chronicle-*.pdf` temps.
- `pnpm seed:demo` (`packages/indexer/scripts/seed-demo.ts`): two vantages, deadline edit → soft_remove → restore on fake chain.
- Security pass notes: `.env` gitignored; API is GET-mostly + rate-limited `/api/*`; match body never logged/stored; git history secret scan should be re-run before submission (`gitleaks` if available). HUMAN: VPS deploy, second live wallet network, 10–20 real pages, confirm explorer links, LICENSE owner name.

### Stage 10 (HUMAN — Cursor cannot submit)

Stage 10 has **no application code**. Checklist for the owner (spec Appendix C + gates):

1. **Deploy** (if not done): VPS India `app` + `watcher-a`; second network `watcher-b`; Caddy → `:8080`; keep up until **23 Oct**.
2. **Docker S8 leftover:** repair Docker Desktop, `docker compose up --build`, record image sizes/startup in Stage 8 notes above.
3. **Live multi-writer:** two funded wallets, two networks, at least the demo change sequence on Tiramisu; fill final addresses in `arkiv/schema.md`.
4. **Watchlist:** enable 10–20 real public pages (robots/terms OK) from 14 Oct onward.
5. **Rehearse:** full demo on the **deployed** URL end-to-end, **twice**.
6. **Video ≤ 3 min** (Appendix C script): problem → publish → change (2 watchers) → verify timeline / live query → match → bundle/`chronicle verify` → why Arkiv + limits.
7. **Submission form** (evening of **18 Oct IST**; hard margin 23:59 BST ≈ 04:29 IST 19 Oct — do not use it):
   - Tracks: Best Indian Use Case + Censorship Resistance
   - Repo, public deployment URL, wallet addresses, baseline SHA (`BASELINE.md`), video link
8. **Record final commit SHA** at submit time. **No history rewrites** afterward.
9. Confirm `LICENSE` owner name, explorer link formats, no secrets in git (`gitleaks` / `git log -p` scan).

Cursor stack through Stage 10 is on `main` (stacked PRs #2–#10 merged 17 Oct). Stretch continues on `stretch-s1`.

### Stretch S1 (contradictions)

- Demo `edit_deadline` accepts `target`: `page` | `pdf` | `both` (admin UI select). Notices keep `deadline` (HTML) and `deadlinePdf` (PDF).
- Indexer `recomputeContradictions` after each `recomputeAll`: for each `notice_id` with page+PDF docs, compare latest content `deadline_ts` / `amount_paise`; open `contradiction` (severity 2) on both docs with both entity keys and badge text `sources disagree: page says X, PDF says Y`.
- UI: Home/Doc badge "Sources disagree"; flag copy never says fraud/fake.
- Verified with unit tests (`contradiction`, `contradiction-indexer`, `deadline-target`, format badges).

## Cut list

- Stage 6B Telegram bot baseline (match/PDF verifier): not wired. Stretch S4 follow-and-alert is on `stretch-s4`. Cut 6B from demo unless finished before freeze.
### Stretch S2 (stealth-removal)

- Watcher: archive `indexes[]` → `index_snapshot` entities (`index_id`, `index_mode`, `observed_at`, `link_count`, `links_sha256`; payload link list). Rolling indexes skipped. Written when link set hash changes.
- Indexer: diff consecutive snapshots per creator; vanished docs → `delisted` (still 200), `stealth_removed` (404/410, no withdrawal title on index), or `declared_withdrawn` (withdrawal-style title appeared). Corroboration (2+ creators) raises severity. UI wording: "removed from listing without a withdrawal notice".

### Stretch S3 (PDF signature / provenance)

- Watcher `normalizePdf` runs `pdfsig` (unsigned if missing); writes `sig_status`, `sig_signer_org` (O= only), `pdf_producer`, `pdf_created_ts`.
- Indexer: `sig_invalid` (severity 3) for `signed_invalid` / `signed_modified`; soft `metadata_inconsistent` (severity 1) for known online editors or CreationDate > printed_date + 30 days.
- UI: "Signature intact" / neutral unsigned copy; never "authentic". Flag explanations avoid fraud/fake.

### Stretch S4 (Telegram follow-and-alert)

- `packages/bot`: grammy long polling; `/follow <type> <value>` (or bare 64-hex doc_id), `/unfollow`, `/list`; subscriptions + `alert_log` in `bot.db` only.
- Dispatcher polls `GET /api/docs?changed_since=` every 60s; UNCONFIRMED (severity ≥ 2, one watcher) then CONFIRMED (2+ creators on same `norm_sha256`); dedupe `(chat, doc, hash, stage)`; max 5 alerts/chat/hour. Never logs chat IDs.
- Stage 6B verifier path still not wired (match/PDF); compose bot entrypoint now runs `node packages/bot/dist/main.js`.

### Stretch S5 (verifier extras)

- `forgery_report` entity mirrored; `/api/match` returns `forgery_reports.distinct_creators` + reason codes (reporter = `$creator`).
- Watchers write `simhash_hex`; near-match when Hamming ≤ 3 → `similar_match` / label "similar, not identical".
- Reply language: `lang=en|ta|hi` on match body/query; Verify page language select. Fixed note strings (S6 will fill payload summaries).

### Stretch S6 (Tamil/Hindi summaries)

- Extraction prompt/schema returns `summary_ta` / `summary_hi` (nullable); watcher stores them on the observation payload when LLM is used.
- Indexer keeps both fields; Doc versions enrich from the first observation entity; timeline exposes them.
- Doc page summary-language toggle; TA/HI labeled "Machine-generated" (fallback to English).

- Stretch cut list otherwise: Docker size numbers and optional community watcher still pending.
- Docker image size/startup numbers: pending local Docker Desktop repair (Stage 8).
- Community Docker watcher joining live in the video: optional if image/GHCR ready in time.

