# Chronicle progress

## Definition of done

- [x] S0 repo, CI green (local `pnpm install && pnpm build && pnpm lint && pnpm test` pass; CI runs once a GitHub remote is added)
- [x] S1 wrapper, fake client, probe results, friction entries
- [x] S2 core domain, tests >= 85 percent
- [ ] S3 demo site with admin mutations
- [ ] S4 watcher, writes to fake and live Arkiv
- [ ] S5 indexer, derived data, API, live attribute-query endpoints
- [ ] S6 web UI + /api/match
- [ ] S6B Telegram bot baseline
- [ ] S7 evidence bundle + CLI verify
- [ ] S8 Docker, compose, community watcher instructions
- [ ] S9 schema.md, friction.md, README, privacy tests, seed demo
- [ ] Two distinct funded wallets, two networks, observations on live Tiramisu
- [ ] 10-20 real public pages watched since 14 Oct (HUMAN)
- [ ] Deployment public and stable
- [ ] Demo video <= 3 minutes
- [ ] Form submitted, SHA recorded
- [ ] Stretch items attempted only after core, cut at 17 Oct 12:00 IST

## Stretch

- [ ] S1 contradictions
- [ ] S2 stealth-removal
- [ ] S3 PDF signature checks
- [ ] S4 follow-and-alert
- [ ] S5 verifier extras
- [ ] S6 Tamil/Hindi

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
  - Fund wallet B (`0x11d34e55Bf7c8FC75FdA5d073653D4B0768d817c`) so that non-owner errors can be checked with a funded caller (unfunded callers get "Execution error without revert data").
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

## Cut list

(none yet)
