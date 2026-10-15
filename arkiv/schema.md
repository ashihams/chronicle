# Chronicle on Arkiv: schema

Filled in during Stage 9 from the actual code and the Stage 1 probe results.

## Overview

## Entities and attributes

Built by `packages/core/src/observation.ts`. Strings are written as Arkiv `str` (at most 128 UTF-8 bytes, never empty; absent values are omitted). Numbers are written as `u64` (non-negative safe integers). Booleans are `0`/`1`. `schema_v` is `1`.

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

### `observation`

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `observation` |
| `schema_v` | u64 | 1 |
| `doc_id`, `notice_id`, `source_kind`, `department`, `scheme` | str | as on `doc` (`scheme` optional) |
| `vantage` | str | watcher environment label |
| `observed_at` | u64 | unix seconds, the watcher's claim |
| `normalizer_version` | str | `n1` |
| `state` | str | `present`, `changed`, `first_seen`, `removed_404`, `removed_410`, `redirected`, `soft_removed`, `unreachable`, `delisted` |
| `http_status` | u64 | 0 on network failure |
| `redirect_chain_len` | u64 | |
| `raw_sha256`, `norm_sha256` | str | omitted for removal and unreachable states |
| `text_extracted` | u64 | 1 text hash, 0 bytes-only (scanned PDF); omitted with the hashes |
| `prev_norm_sha256` | str | previous content hash this watcher saw, optional |
| `last_modified_ts`, `printed_date_ts`, `deadline_ts` | u64 | unix seconds; dates are 00:00 IST |
| `deadline_date` | str | `YYYY-MM-DD` |
| `amount_paise` | u64 | integer paise |
| `severity` | u64 | 0-3 |
| `simhash_hex`, `sig_status`, `sig_signer_org`, `pdf_producer`, `pdf_created_ts` | str / u64 | stretch only; free text truncated to 128 bytes |

Baseline uses at most 23 attributes; with every stretch field it is 28, under Arkiv's 30-attribute limit (32 cells minus `$payload` and `$contentType`).

Payload (JSON, at most 4096 bytes, no document text): `{ title, summary_en, summary_ta, summary_hi, final_url, changes[], extractor: { model, confidence }, declared_supersedes }`. A `text` change carries the previous and new normalized hashes, never text.

## Time semantics

## Why each field is an attribute

## Kept off Arkiv on purpose

## Expiry, deletion and testnet limitations

## Trust model

## Wallet addresses used

## Derived data is recomputable
