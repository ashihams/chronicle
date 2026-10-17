import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * Stretch S4 / Stage 6B privacy: never log chat IDs, message text, or filter values.
 * Subscriptions may be stored in bot.db only.
 */
describe('privacy', () => {
  it('bot and dispatcher log lines do not interpolate chatId or filter values', () => {
    const files = ['bot.ts', 'dispatcher.ts', 'run.ts', 'main.ts'];
    for (const f of files) {
      const src = readFileSync(join(srcDir, f), 'utf8');
      expect(src, f).not.toMatch(/log\.(info|warn|error|debug)\([^)]*chatId/);
      expect(src, f).not.toMatch(/log\.(info|warn|error|debug)\([^)]*filterValue/);
      expect(src, f).not.toMatch(/log\.(info|warn|error|debug)\([^)]*chat_id/);
    }
  });
});
