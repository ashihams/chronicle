# Chronicle progress

## Definition of done

- [x] S0 repo, CI green (local `pnpm install && pnpm build && pnpm lint && pnpm test` pass; CI runs once a GitHub remote is added)
- [ ] S1 wrapper, fake client, probe results, friction entries
- [ ] S2 core domain, tests >= 85 percent
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

## Cut list

(none yet)
