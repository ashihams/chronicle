import type { Config } from '../config.js';
import { FakeArkivClient } from './fake.js';
import { LiveArkivClient } from './live.js';
import type { ArkivClient } from './types.js';

export interface CreateArkivClientOptions {
  /** Defaults to the watcher key from config. Pass null for a read-only live client. */
  privateKey?: string | null;
  /** Used in fake mode to share one in-memory chain between clients. */
  fake?: FakeArkivClient;
}

export function createArkivClient(config: Config, opts: CreateArkivClientOptions = {}): ArkivClient {
  if (config.arkiv.mode === 'fake') return opts.fake ?? new FakeArkivClient();
  const privateKey = opts.privateKey === undefined ? config.watcher.privateKey : (opts.privateKey ?? undefined);
  return new LiveArkivClient({
    chainId: config.arkiv.chainId,
    rpcHttp: config.arkiv.rpcHttp,
    rpcWs: config.arkiv.rpcWs,
    ...(privateKey !== undefined && { privateKey }),
  });
}
