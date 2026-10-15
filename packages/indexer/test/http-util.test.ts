import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RateLimiter, explorerLinks, resolveStatic } from '../src/http-util.js';

describe('explorerLinks', () => {
  it('builds entity, tx and address links without a double slash', () => {
    const l = explorerLinks('https://explorer.example.test//');
    expect(l.entity('0xab')).toBe('https://explorer.example.test/entity/0xab');
    expect(l.tx('0xcd')).toBe('https://explorer.example.test/tx/0xcd');
    expect(l.address('0xef')).toBe('https://explorer.example.test/address/0xef');
  });
});

describe('RateLimiter', () => {
  it('allows max requests per window per client', () => {
    let now = 0;
    const r = new RateLimiter(2, 60_000, () => now);
    expect([r.hit('a'), r.hit('a'), r.hit('b')]).toEqual([0, 0, 0]);
    now = 30_000;
    expect(r.hit('a')).toBe(30);
    now = 60_000;
    expect(r.hit('a')).toBe(0);
  });
});

describe('resolveStatic', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-static-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), 'INDEX');
  writeFileSync(join(root, 'assets', 'a.css'), 'body{}');
  writeFileSync(join(root, 'assets', 'x.bin'), 'bin');

  it('serves files with a content type and falls back to index.html', () => {
    expect(resolveStatic(root, '/assets/a.css?v=1')).toMatchObject({ contentType: 'text/css; charset=utf-8' });
    expect(resolveStatic(root, '/assets/x.bin')?.contentType).toBe('application/octet-stream');
    expect(resolveStatic(root, '/docs/abc')?.body.toString()).toBe('INDEX');
    expect(resolveStatic(root, '/')?.body.toString()).toBe('INDEX');
    expect(resolveStatic(root, '/assets')?.body.toString()).toBe('INDEX');
  });

  it('never serves a file outside the build and refuses bad encodings', () => {
    const parent = mkdtempSync(join(tmpdir(), 'chronicle-static-'));
    const web = join(parent, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), 'INDEX');
    writeFileSync(join(parent, 'secret.txt'), 'SECRET');
    for (const p of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/..%5csecret.txt',
      '/%2e%2e%5csecret.txt',
    ]) {
      const r = resolveStatic(web, p);
      expect(r === null || r.body.toString() === 'INDEX', p).toBe(true);
    }
    expect(resolveStatic(root, '/%E0%A4%A')).toBeNull();
  });

  it('returns null when there is no index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'chronicle-static-'));
    expect(resolveStatic(empty, '/anything')).toBeNull();
  });
});
