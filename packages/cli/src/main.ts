#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createArkivClient, loadConfig, type Config } from '@chronicle/core';
import { Command } from 'commander';
import { formatEntity } from './entity.js';
import { formatVerifyTable, verifyBundleJson } from './verify.js';

function configWithRpc(rpc?: string): Config {
  const env = { ...process.env };
  if (rpc !== undefined) {
    env.ARKIV_RPC_HTTP = rpc;
    // WebSocket is unused for these read-only CLI calls; keep a plausible sibling URL.
    if (env.ARKIV_RPC_WS === undefined || env.ARKIV_RPC_WS === '') {
      env.ARKIV_RPC_WS = rpc.replace(/^http/, 'ws');
    }
  }
  return loadConfig(env);
}

const program = new Command();
program.name('chronicle').description('Chronicle evidence bundle and Arkiv inspect tools').version('0.1.0');

program
  .command('bundle')
  .description('Fetch an evidence bundle from a Chronicle API')
  .argument('<doc_id>', '64-char lowercase hex doc id')
  .option('--api <url>', 'API base URL', process.env.API_BASE_URL ?? 'http://localhost:8080')
  .option('--out <file>', 'Write JSON to this file instead of stdout')
  .action(async (docId: string, opts: { api: string; out?: string }) => {
    if (!/^[0-9a-f]{64}$/.test(docId)) {
      console.error('doc_id must be 64 lowercase hex characters');
      process.exitCode = 1;
      return;
    }
    const base = opts.api.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/bundle/${docId}`);
    const body = (await res.json()) as { error?: string };
    if (!res.ok) {
      console.error(body.error ?? `HTTP ${res.status}`);
      process.exitCode = 1;
      return;
    }
    const text = JSON.stringify(body, null, 2);
    if (opts.out !== undefined) {
      writeFileSync(resolve(opts.out), text + '\n', 'utf8');
      console.error(`wrote ${opts.out}`);
    } else {
      console.log(text);
    }
  });

program
  .command('verify')
  .description('Verify an evidence bundle against Arkiv')
  .argument('<bundle.json>', 'Path to a bundle file')
  .option('--rpc <url>', 'Override RPC HTTP URL (default: from the bundle)')
  .action(async (file: string, opts: { rpc?: string }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const rpc =
      opts.rpc ??
      (typeof raw === 'object' && raw !== null && 'rpc' in raw && typeof (raw as { rpc: unknown }).rpc === 'string'
        ? (raw as { rpc: string }).rpc
        : undefined);
    const config = configWithRpc(rpc);
    // Read-only client; fake mode still works for tests that inject ARKIV_MODE=fake.
    const arkiv = createArkivClient(config, { privateKey: null });
    try {
      const report = await verifyBundleJson(arkiv, raw);
      console.log(formatVerifyTable(report));
      process.exitCode = report.exitCode;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('entity')
  .description('Print a live Arkiv entity')
  .argument('<key>', '0x-prefixed entity key')
  .option('--rpc <url>', 'RPC HTTP URL (or use ARKIV_RPC_HTTP from the environment)')
  .action(async (key: string, opts: { rpc?: string }) => {
    const config = configWithRpc(opts.rpc);
    const arkiv = createArkivClient(config, { privateKey: null });
    try {
      console.log(await formatEntity(arkiv, key));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
