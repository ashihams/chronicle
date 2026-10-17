import { z } from 'zod';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const str = (def: string) => z.preprocess(emptyToUndefined, z.string().default(def));
const optStr = () => z.preprocess(emptyToUndefined, z.string().optional());
const int = (def: number, min = 0) => z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).default(def));
const url = (def: string) => z.preprocess(emptyToUndefined, z.string().url().default(def));

const EnvSchema = z.object({
  ARKIV_MODE: z.preprocess(emptyToUndefined, z.enum(['live', 'fake']).default('live')),
  ARKIV_CHAIN_ID: int(7738577, 1),
  ARKIV_RPC_HTTP: url('https://rpc.tiramisu.db-chain.testnet.arkiv.network'),
  ARKIV_RPC_WS: url('wss://rpc.tiramisu.db-chain.testnet.arkiv.network'),
  EXPLORER_BASE: url('https://tiramisu.explorer.arkiv.network'),

  WATCHER_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex private key')
      .optional(),
  ),
  VANTAGE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'must be a lowercase slug, e.g. in-vps or community-alice')
      .default('in-vps'),
  ),
  WATCHLIST_PATH: str('./watchlist.json'),
  WATCHLIST_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  DATA_DIR: str('./data'),
  POLL_HOURS_DEFAULT: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(6)),
  HEARTBEAT_HOURS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(24)),
  REQUEST_DELAY_MS_PER_HOST: int(5000),
  FETCH_TIMEOUT_MS: int(20000, 1),
  USER_AGENT: str('ChronicleWatcher/1.0 (+https://github.com/OWNER/chronicle; contact: EMAIL)'),
  OBSERVATION_TTL_DAYS: int(180, 1),
  RENEW_WHEN_DAYS_LEFT: int(30, 0),
  WATCHER_HEALTH_PORT: int(8081, 1),

  GROQ_API_KEY: optStr(),
  GROQ_MODEL: str('openai/gpt-oss-120b'),

  PORT: int(8080, 1),
  INDEXER_DB_PATH: str('./data/indexer.db'),
  SYNC_INTERVAL_SECONDS: int(20, 1),
  LIVENESS_INTERVAL_MINUTES: int(30, 1),
  DISAGREE_WINDOW_MINUTES: int(30, 1),
  BACKDATE_DAYS: int(7, 0),
  CLOCK_SKEW_SECONDS: int(3600, 0),

  TELEGRAM_BOT_TOKEN: optStr(),
  API_BASE_URL: url('http://localhost:8080'),
  BOT_DB_PATH: str('./data/bot.db'),
  BOT_MAX_FILE_MB: int(10, 1),

  DEMO_PORT: int(4000, 1),
  DEMO_ADMIN_TOKEN: str('change-me'),
});

export type EnvKey = keyof z.infer<typeof EnvSchema>;

export interface Config {
  arkiv: {
    mode: 'live' | 'fake';
    chainId: number;
    rpcHttp: string;
    rpcWs: string;
    explorerBase: string;
  };
  watcher: {
    privateKey: string | undefined;
    vantage: string;
    watchlistPath: string;
    watchlistUrl: string | undefined;
    dataDir: string;
    pollHoursDefault: number;
    heartbeatHours: number;
    requestDelayMsPerHost: number;
    fetchTimeoutMs: number;
    userAgent: string;
    observationTtlDays: number;
    renewWhenDaysLeft: number;
    healthPort: number;
  };
  llm: {
    groqApiKey: string | undefined;
    model: string;
  };
  indexer: {
    port: number;
    dbPath: string;
    syncIntervalSeconds: number;
    livenessIntervalMinutes: number;
    disagreeWindowMinutes: number;
    backdateDays: number;
    clockSkewSeconds: number;
  };
  bot: {
    telegramBotToken: string | undefined;
    apiBaseUrl: string;
    dbPath: string;
    maxFileMb: number;
  };
  demo: {
    port: number;
    adminToken: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Variables that must be present and non-empty for the calling process. */
  require?: EnvKey[];
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  opts: LoadConfigOptions = {},
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;

  const missing = (opts.require ?? []).filter((k) => e[k] === undefined);
  if (missing.length > 0) {
    throw new ConfigError(missing.map((k) => `${k}: required but missing or empty`));
  }

  return {
    arkiv: {
      mode: e.ARKIV_MODE,
      chainId: e.ARKIV_CHAIN_ID,
      rpcHttp: e.ARKIV_RPC_HTTP,
      rpcWs: e.ARKIV_RPC_WS,
      explorerBase: e.EXPLORER_BASE.replace(/\/+$/, ''),
    },
    watcher: {
      privateKey: e.WATCHER_PRIVATE_KEY,
      vantage: e.VANTAGE,
      watchlistPath: e.WATCHLIST_PATH,
      watchlistUrl: e.WATCHLIST_URL,
      dataDir: e.DATA_DIR,
      pollHoursDefault: e.POLL_HOURS_DEFAULT,
      heartbeatHours: e.HEARTBEAT_HOURS,
      requestDelayMsPerHost: e.REQUEST_DELAY_MS_PER_HOST,
      fetchTimeoutMs: e.FETCH_TIMEOUT_MS,
      userAgent: e.USER_AGENT,
      observationTtlDays: e.OBSERVATION_TTL_DAYS,
      renewWhenDaysLeft: e.RENEW_WHEN_DAYS_LEFT,
      healthPort: e.WATCHER_HEALTH_PORT,
    },
    llm: {
      groqApiKey: e.GROQ_API_KEY,
      model: e.GROQ_MODEL,
    },
    indexer: {
      port: e.PORT,
      dbPath: e.INDEXER_DB_PATH,
      syncIntervalSeconds: e.SYNC_INTERVAL_SECONDS,
      livenessIntervalMinutes: e.LIVENESS_INTERVAL_MINUTES,
      disagreeWindowMinutes: e.DISAGREE_WINDOW_MINUTES,
      backdateDays: e.BACKDATE_DAYS,
      clockSkewSeconds: e.CLOCK_SKEW_SECONDS,
    },
    bot: {
      telegramBotToken: e.TELEGRAM_BOT_TOKEN,
      apiBaseUrl: e.API_BASE_URL.replace(/\/+$/, ''),
      dbPath: e.BOT_DB_PATH,
      maxFileMb: e.BOT_MAX_FILE_MB,
    },
    demo: {
      port: e.DEMO_PORT,
      adminToken: e.DEMO_ADMIN_TOKEN,
    },
  };
}
