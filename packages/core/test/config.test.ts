import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const KEY = '0x' + 'ab'.repeat(32);

describe('loadConfig', () => {
  it('applies defaults from section 4 when env is empty', () => {
    const c = loadConfig({});
    expect(c.arkiv.mode).toBe('live');
    expect(c.arkiv.chainId).toBe(7738577);
    expect(c.arkiv.rpcHttp).toBe('https://rpc.tiramisu.db-chain.testnet.arkiv.network');
    expect(c.watcher.vantage).toBe('in-vps');
    expect(c.watcher.observationTtlDays).toBe(180);
    expect(c.watcher.privateKey).toBeUndefined();
    expect(c.indexer.port).toBe(8080);
    expect(c.bot.maxFileMb).toBe(10);
    expect(c.demo.port).toBe(4000);
  });

  it('coerces numbers and treats empty strings as unset', () => {
    const c = loadConfig({ PORT: '9090', WATCHER_PRIVATE_KEY: '', WATCHLIST_URL: '  ', POLL_HOURS_DEFAULT: '0.5' });
    expect(c.indexer.port).toBe(9090);
    expect(c.watcher.privateKey).toBeUndefined();
    expect(c.watcher.watchlistUrl).toBeUndefined();
    expect(c.watcher.pollHoursDefault).toBe(0.5);
  });

  it('accepts a well-formed private key', () => {
    expect(loadConfig({ WATCHER_PRIVATE_KEY: KEY }).watcher.privateKey).toBe(KEY);
  });

  it('strips trailing slashes from base URLs', () => {
    const c = loadConfig({ EXPLORER_BASE: 'https://x.example/', API_BASE_URL: 'http://localhost:8080//' });
    expect(c.arkiv.explorerBase).toBe('https://x.example');
    expect(c.bot.apiBaseUrl).toBe('http://localhost:8080');
  });

  it('fails fast on invalid values and names every bad variable', () => {
    try {
      loadConfig({ ARKIV_MODE: 'prod', PORT: 'abc', WATCHER_PRIVATE_KEY: 'secret', VANTAGE: 'Has Spaces' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as ConfigError).message;
      expect(msg).toContain('ARKIV_MODE');
      expect(msg).toContain('PORT');
      expect(msg).toContain('WATCHER_PRIVATE_KEY');
      expect(msg).toContain('VANTAGE');
      expect(msg).not.toContain('secret');
    }
  });

  it('enforces per-process required variables', () => {
    expect(() => loadConfig({}, { require: ['WATCHER_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN'] })).toThrowError(
      /WATCHER_PRIVATE_KEY: required[\s\S]*TELEGRAM_BOT_TOKEN: required/,
    );
    expect(() => loadConfig({ WATCHER_PRIVATE_KEY: KEY }, { require: ['WATCHER_PRIVATE_KEY'] })).not.toThrow();
  });
});
