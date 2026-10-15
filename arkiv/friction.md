# Arkiv friction log

Each entry follows this template:

```
### <short title>
- Date: YYYY-MM-DD
- What I tried: <exact call or command>
- Expected: <what the docs imply>
- Actual: <error text or behavior>
- Reproduce: <numbered steps, SDK version, endpoint>
- Impact: <what it blocked or slowed>
- Suggested fix: <docs or SDK change>
```

## Entries

## Found while reading the SDK source (Stage 1)

### No glob or pattern operator other than prefix
- Date: 2026-10-15
- What I tried: Looked for a `glob` combinator in `@arkiv-network/sdk/query` (src/query/expression.ts); also sent the raw query `qtag GLOB str('odd-*')` (probe e05).
- Expected: Glob matching on string attributes, as earlier Arkiv/Golem DB material and our spec assumed.
- Actual: The query language has `=`, `!=`, `<`, `<=`, `>`, `>=`, `STARTSWITH`, `EXISTS`, `TYPEOF`, `AND`, `OR`, `NOT`. `STARTSWITH` is the only pattern operator. Result of the raw GLOB query is recorded in probe-results.json (e05_query.glob_raw).
- Reproduce: 1. `pnpm add @arkiv-network/sdk@0.8.1`. 2. Read `src/query/expression.ts`. 3. `pnpm probe -- --only=e05`. Endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network.
- Impact: Chronicle's ArkivClient exposes `prefix` instead of `glob`.
- Suggested fix: State the full operator list on docs.arkiv.network next to the query examples.

### No server-side ordering
- Date: 2026-10-15
- What I tried: Looked for `orderBy` on `SelectQueryBuilder` and `QueryOptions` (src/query/queryBuilder.ts, src/actions/public/query.ts).
- Expected: Ordering by an attribute, so "latest observation per doc" is one query.
- Actual: No ordering option exists. Result order is whatever the node returns (recorded in e05_query.resultOrder).
- Reproduce: SDK 0.8.1, read the files above.
- Impact: Chronicle dropped `orderBy` from its ArkivClient interface and sorts client-side or in the indexer mirror.
- Suggested fix: Add ORDER BY on ordered types, or document that results are unordered.

### Entity records do not include the creating transaction hash
- Date: 2026-10-15
- What I tried: `publicClient.getEntity(key)` and `select("*")` (src/types/entity.ts).
- Expected: The tx hash that created the entity, for explorer links and evidence bundles.
- Actual: Fields are key, owner, creator, createdAt, updatedAt, expiresAt, creationFlags, contentType, payload, attributeSchema, attributes. No tx hash (probe e02: `txHashOnEntity: false`).
- Reproduce: 1. Create an entity. 2. `getEntity(key)` and inspect the object. SDK 0.8.1.
- Impact: Chronicle looks up the `EntityCreated` log in the creation block with `eth_getLogs` to recover the tx hash (one extra RPC call per entity).
- Suggested fix: Return the creating tx hash (and log index) from `arkiv_query`.

### The address that emits entity events is not exported
- Date: 2026-10-15
- What I tried: Filtering `getLogs` for `EntityCreated` by emitter address.
- Expected: An exported constant for the Arkiv processor address.
- Actual: `ARKIV_ADDRESS = 0x4400000000000000000000000000000000000044` lives in `src/consts.ts` and is not part of the public exports (`ENTITY_EVENTS_ABI` is exported). A commented-out older value is also in that file.
- Reproduce: SDK 0.8.1, read `src/consts.ts` and `src/index.ts`.
- Impact: Chronicle copies the constant into `packages/core/src/arkiv/sdk.ts`; it will silently break if the address changes.
- Suggested fix: Export `ARKIV_ADDRESS` (or a `getEntityLogs` helper).

### Strings are limited to 128 bytes and numbers default to i32
- Date: 2026-10-15
- What I tried: Writing a full source URL as a `str` attribute and bare JS numbers for timestamps (probe e03).
- Expected: Docs say attributes are "string or numeric".
- Actual: `str` is at most 128 UTF-8 bytes. A bare number is an `i32`, so unix timestamps work only until 2038 and paise amounts above about 2.1 crore fail. Numbers must be wrapped in `u64(...)`, and queries must use the same type or they silently match nothing.
- Reproduce: `pnpm probe -- --only=e03,e05`. SDK 0.8.1.
- Impact: Chronicle stores every number as `u64`, keeps long URLs in the payload, and limits string attributes to 128 bytes.
- Suggested fix: Put the type table (src/attr/types.ts) and the 128-byte limit on the docs site.

### Query errors use generic JSON-RPC messages
- Date: 2026-10-15
- What I tried: Raw queries `qtag > str('a')` (string range) and `qtag GLOB str('odd-*')` (probe e05).
- Expected: "string attributes do not support range comparisons" and "unknown operator GLOB".
- Actual: `Query rejected (type, -32002): Requested resource not available.` and `Query rejected (parse, -32001): Requested resource not found.` Only the `type` / `parse` tag hints at the cause.
- Reproduce: `pnpm probe -- --only=e05`. SDK 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network.
- Impact: Minutes lost per query mistake; Chronicle validates queries client-side before sending (`validateQuery`).
- Suggested fix: Return the parser or type checker message in the error data.

### Explorer returns 200 for any path
- Date: 2026-10-15
- What I tried: GET https://tiramisu.explorer.arkiv.network/tx/<hash>, /entity/<key>, /entities/<key>, /address/<addr>, /block/<n> (probe e13).
- Expected: 404 for unsupported routes, so link formats can be checked automatically.
- Actual: Every path returns 200 with the same single-page-app shell, so the correct deep-link formats cannot be confirmed without a browser.
- Reproduce: `pnpm probe -- --only=e13`.
- Impact: Chronicle's explorer links must be checked by hand (HUMAN item in PROGRESS.md).
- Suggested fix: Document the explorer URL scheme for transactions, entities and addresses.

<!-- probe:start -->
## Automatically recorded by `pnpm probe` (run pmv9v9e53+pmv9vith1+pmv9vjcbh, 2026-10-15)

### A bare JS number in a query silently matches nothing against u64 attributes
- Date: 2026-10-15
- What I tried: client.query(eq('qn', 2)) where qn was written as u64(2)
- Expected: Numeric equality matches the stored number
- Actual: 0 results, no error. A bare number is an i32 literal, and a type mismatch matches nothing
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run `pnpm probe -- --only=e05_query`. SDK @arkiv-network/sdk 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network, probe run pmv9v9e53+pmv9vith1+pmv9vjcbh.
- Impact: Easy to miss in application code; Chronicle always wraps numbers in u64() in the ArkivClient wrapper
- Suggested fix: Warn or error in the SDK when a predicate type cannot match the attribute type; document prominently

### The node filters on $createdAt, but the SDK refuses to build that predicate
- Date: 2026-10-15
- What I tried: gt('$createdAt', u64(N)) via @arkiv-network/sdk/query, then the raw string "... AND $createdAt >= u64(N)" via client.query(string)
- Expected: Either both work or both fail (the SDK says $createdAt "carries no index")
- Actual: The SDK throws InvalidPredicateError; the raw string query returns correct results (>= own block: 1, > own block: 0, < own block: 0)
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run `pnpm probe -- --only=e06_created_after_block`. SDK @arkiv-network/sdk 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network, probe run pmv9v9e53+pmv9vith1+pmv9vjcbh.
- Impact: Incremental sync by creation block needs an unchecked raw query string, or event logs
- Suggested fix: Allow $createdAt in QUERYABLE_SYSTEM_ATTRIBUTES, or document that the node supports it

### eth_getLogs rejects wide block ranges with a generic error
- Date: 2026-10-15
- What I tried: publicClient.getLogs({ address: 0x4400000000000000000000000000000000000044, event: EntityCreated, fromBlock: head-50000, toBlock: head })
- Expected: Either results or an error naming the maximum range
- Actual: InvalidParamsRpcError "Invalid parameters were provided to the RPC method". Largest range that worked: 10000 blocks
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run `pnpm probe -- --only=e06_created_after_block`. SDK @arkiv-network/sdk 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network, probe run pmv9v9e53+pmv9vith1+pmv9vjcbh.
- Impact: Indexer must page event logs in windows of at most the working range
- Suggested fix: Document the eth_getLogs range limit and return it in the error message

### A one-block lifetime is accepted but the entity is never readable
- Date: 2026-10-15
- What I tried: createEntity({ ..., expires: ExpirationTime.fromBlocks(1) }) then getEntity(key)
- Expected: Either rejected as dead on arrival, or readable for one block
- Actual: The create succeeds (gas is spent), but getEntity right after the receipt throws NoEntityFoundError
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run `pnpm probe -- --only=e07_expiry`. SDK @arkiv-network/sdk 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network, probe run pmv9v9e53+pmv9vith1+pmv9vjcbh.
- Impact: None for Chronicle (we use 180 days); a trap for short-lived data
- Suggested fix: Reject lifetimes that cannot outlive the inclusion block, or document the minimum useful lifetime

### Non-owner mutation from an unfunded wallet fails without a reason
- Date: 2026-10-15
- What I tried: patchEntity / extendEntity / deleteEntity / changeOwnership from a wallet with 0 balance on an entity it does not own
- Expected: A NotOwner(entityKey, caller, owner) error, as the SDK reports for funded callers
- Actual: EntityMutationError: "EntityMutationError: Transaction failed: Execution error without revert data"
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run `pnpm probe -- --only=e08_permissions`. SDK @arkiv-network/sdk 0.8.1, endpoint https://rpc.tiramisu.db-chain.testnet.arkiv.network, probe run pmv9v9e53+pmv9vith1+pmv9vjcbh.
- Impact: Cannot tell "not the owner" apart from "no gas" when testing permissions
- Suggested fix: Decode the revert during simulation regardless of balance, or say that the caller has no funds
<!-- probe:end -->
