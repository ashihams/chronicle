# Chronicle on Arkiv: schema

Gate file for the Arkiv Global Tour Stop. Matches the code in `@chronicle/core` (`observation.ts`, `arkiv/limits.ts`) and the Stage 1 probe (`arkiv/probe-results.json`). SDK: `@arkiv-network/sdk` ~0.8.1. Chain: Tiramisu testnet (`ARKIV_CHAIN_ID=7738577`).

## Overview

Chronicle writes **doc** and **observation** entities to Arkiv (stretch may add `index_snapshot` and `forgery_report`). Writers are independent watcher wallets. The indexer mirrors entities into SQLite, derives versions and flags, and serves a read-only API. Derived rows are a cache: evidence is the on-chain entity set plus the evidence bundle.

Hard limits used everywhere:

| Limit | Value | Source |
|---|---|---|
| User attributes per entity | ≤ 30 | 32 cells − `$payload` − `$contentType` |
| `str` attribute | ≤ 128 UTF-8 bytes, never empty | SDK / probe e03 |
| Numbers | always `u64` | bare JS numbers are `i32` and mismatch silently |
| Payload | ≤ 128 KB SDK; observation payloads ≤ 4 KB | Stage 1 / section 5.3 |
| Block time | 2 s; TTL rounded up to a multiple of 2 s | `ttlToBlocks` |

Booleans are stored as numeric `0`/`1`. Empty optional fields are **omitted**, never empty strings. `schema_v` is always `1`. Writer identity is Arkiv `$creator` (not duplicated as an attribute).

## Entities and attributes

Built by `packages/core/src/observation.ts`.

### `doc`

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `doc` |
| `schema_v` | u64 | 1 |
| `doc_id` | str | sha256 hex of the canonical source URL |
| `notice_id` | str | id from `watchlist.json` |
| `source_kind` | str | `page` \| `pdf` |
| `source_url` | str | canonical URL, **only when it fits in 128 bytes** |
| `department` | str | slug |
| `scheme` | str | slug, optional |
| `lang` | str | `en`, `hi`, `ta`, ... |

Payload (JSON): `{ title, registered_vantage, source_url }`. `source_url` is always in the payload because the attribute may be omitted.

Before create, the watcher queries `type=doc AND doc_id=<id>`. If any writer already registered the doc, it reuses that key. Duplicate docs from races are deduplicated in the indexer (earliest creation block wins).

### `observation`

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `observation` |
| `schema_v` | u64 | 1 |
| `doc_id`, `notice_id`, `source_kind`, `department`, `scheme` | str | as on `doc` (`scheme` optional) |
| `vantage` | str | watcher environment label |
| `observed_at` | u64 | unix seconds, the watcher's claim |
| `normalizer_version` | str | `n1` |
| `state` | str | see states below |
| `http_status` | u64 | 0 on network failure |
| `redirect_chain_len` | u64 | |
| `raw_sha256`, `norm_sha256` | str | omitted for removal and unreachable states |
| `text_extracted` | u64 | 1 text hash, 0 bytes-only (scanned PDF); omitted with the hashes |
| `prev_norm_sha256` | str | previous content hash this watcher saw, optional |
| `last_modified_ts`, `printed_date_ts`, `deadline_ts` | u64 | unix seconds; dates are 00:00 IST |
| `deadline_date` | str | `YYYY-MM-DD` |
| `amount_paise` | u64 | integer paise |
| `severity` | u64 | 0–3 |
| `simhash_hex`, `sig_status`, `sig_signer_org`, `pdf_producer`, `pdf_created_ts` | str / u64 | stretch only; free text truncated to 128 bytes |

Baseline uses at most 23 attributes; with every stretch field it is 28 (under 30).

**States:** `present`, `changed`, `first_seen`, `removed_404`, `removed_410`, `redirected`, `soft_removed`, `unreachable`, `delisted` (stretch).

Payload (JSON, ≤ 4096 bytes, **no document text**):

```json
{
  "title": "string|null",
  "summary_en": "string <= 240 chars",
  "summary_ta": "string|null",
  "summary_hi": "string|null",
  "final_url": "string",
  "changes": [{ "field": "deadline|amount|text|removed", "from": "string|null", "to": "string|null" }],
  "extractor": { "model": "string", "confidence": 0.0 },
  "declared_supersedes": "string|null"
}
```

A `text` change carries previous/new **hashes**, never body text.

### `index_snapshot` (stretch S2 only)

Attrs: `index_id`, `index_mode`, `observed_at`, `link_count`, `links_sha256`; payload `{ links: [{ doc_id, title<=120 }] }`.

### `forgery_report` (stretch S5 only)

Attrs: `norm_sha256`, `reason_code` (slug), optional `real_source_url` (≤128 bytes). Reporter is Arkiv `$creator` (not an attribute). Indexer `/api/match` returns distinct creator counts for the matched hash. Never stores personal data.

## Time semantics

| Clock | Meaning |
|---|---|
| `observed_at` | Watcher's wall-clock claim when the check ran (attribute, u64). Can be wrong or skewed; indexer may flag `clock_skew`. |
| Chain creation block / `$createdAt` | Arkiv inclusion time. Indexer stores creation block and recovers creating tx via `EntityCreated` logs. |
| `first_seen` (derived) | Earliest accepted observation for a content version in the mirror (not an Arkiv attribute). |
| `printed_date_ts` / `deadline_ts` | Dates extracted from the document, normalized to 00:00 IST unix seconds. |
| `last_modified_ts` | HTTP `Last-Modified` when present. |

UI and evidence bundles show both claimed `observed_at` and chain/block time so judges can compare.

## Why each field is an attribute

Attributes exist so `/api/arkiv/*` and watchers can filter without downloading every payload. Exact queries the code issues (via `ArkivClient.query` / live API):

| Query purpose | Where (conceptual) |
|---|---|
| Find existing doc | `type = doc AND doc_id = <id>` |
| Recent observations (indexer sync) | `type = observation AND observed_at >= <u64>` |
| All docs / index snapshots | `type = doc` / `type = index_snapshot` |
| Deadline changes (live panel) | `type = observation AND deadline_ts >= 0` then post-filter payload `changes` for `field=deadline` |
| Amount changes | `type = observation AND amount_paise >= 0` (+ post-filter) |
| By department | `type = observation AND department = <slug>` (and docs similarly) |
| By creator | Arkiv `creator` filter on the query (not a user attribute) |
| Watcher renewal / ownership | `getEntity` + owner checks; extend when TTL low |

Fields that are only display or large (full URL when >128 bytes, summaries, change lists) stay in the **payload**.

## Kept off Arkiv on purpose

Never written as attributes or payloads:

- Full document HTML/PDF bytes or normalized body text
- User uploads from `/api/match` or the Telegram bot
- Telegram chat IDs, user IDs, message contents
- Personal names, phone numbers, emails
- Individual signer names (`sig_signer_org` is organization only, stretch)
- Private keys, bot tokens, admin tokens

Local only: watcher SQLite (`DATA_DIR`), indexer SQLite, `bot.db` subscriptions (stretch).

## Expiry, deletion and testnet limitations

From Stage 1 probe (see `friction.md` and `probe-results.json`):

- Default TTL: `OBSERVATION_TTL_DAYS` (180). Renew when fewer than `RENEW_WHEN_DAYS_LEFT` (30) days remain.
- Lifetimes must be a multiple of 2 seconds; Chronicle rounds up.
- `extendEntity` sets a new expiry from **now** and fails if that is not later than the current expiry.
- Expired/deleted entities disappear from `getEntity` / live `query`, but may still be visible with `atBlock` before expiry/delete.
- A 1-block lifetime creates successfully but is immediately unreadable (probe e07) — Chronicle does not use short TTLs.
- Testnet: gas and faucet funding required; shared chain means other projects' `type=observation` entities appear — indexer validates attributes with zod and ignores invalid keys.
- Throughput: sequential creates ~6 s each; batching helps (probe e12). Watcher serializes writes per wallet (`serializeWrites`).

## Trust model

- **Creator vs owner:** `$creator` is immutable; `$owner` can change after transfer. Only the owner can patch/extend/delete/transfer. After transfer, creator stays the original writer (probe e08).
- **Sybil / lying watchers:** anyone with a funded key can write false observations. Chronicle does not claim authenticity of content — only that a named vantage claimed a hash/state at a time. Corroboration = multiple distinct creators / vantages agreeing on `norm_sha256`.
- **Independent vantages:** same machine or same egress IP is **not** independent. Labels (`VANTAGE=in-vps`, `community-<name>`) are claims, not proofs of location.
- **Indexer operator:** can lie in the UI/API mirror; evidence bundles + `chronicle verify` re-fetch entities from Arkiv to detect mismatch.
- **Demo watchlist:** refused in `NODE_ENV=production` unless `ALLOW_DEMO=1`.

## Wallet addresses used

Private keys live only in `.env` / deployment secrets (`WATCHER_PRIVATE_KEY`, `WATCHER_B_PRIVATE_KEY`). Never commit keys.

| Role | Address | Notes |
|---|---|---|
| Watcher A (`VANTAGE=in-vps`) | `0x34ccbad283b69a61bd8dd01b97fe6c27377524fe` | Live Tiramisu writes (PROGRESS Stage 4); compose `watcher-a` |
| Watcher B (`VANTAGE=eu-vps`) | `0x11d34e55Bf7c8FC75FdA5d073653D4B0768d817c` | Second funded wallet (same address as probe B). Run on a **different network/host** than A for independent vantage. Compose `watcher-b` ← `WATCHER_B_PRIVATE_KEY` |
| Probe / permission tests | `0x11d34e55Bf7c8FC75FdA5d073653D4B0768d817c` | `PROBE_SECOND_PRIVATE_KEY` / `pnpm probe` |
| Community watchers | _(optional)_ | Distinct keys + `VANTAGE=community-<name>` |

**Explorer:** entity deep links use `{EXPLORER_BASE}/entity/<key>` (default `https://tiramisu.explorer.arkiv.network`). After the first live write, open a doc timeline in the UI and confirm the explorer link for an observation key.

**HUMAN still required:** fund both wallets via the Tiramisu faucet; run A and B on distinct egress; keep a public HTTPS URL (see `deploy/Caddyfile`) up through 23 Oct.

## Derived data is recomputable

Indexer SQLite (`entities`, `docs`, `versions`, `flags`, timelines, ignored keys) is rebuilt from Arkiv queries + `getEntity`. Deleting the DB and re-syncing must reproduce the same derived versions/flags for the same normalizer rules. Evidence is the chain entities, not the mirror.
