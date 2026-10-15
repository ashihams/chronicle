import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Resolve `@chronicle/<pkg>` to source so tests never depend on a prior build. */
export const chronicleAliases = [
  {
    find: /^@chronicle\/([a-z-]+)$/,
    replacement: `${root}packages/$1/src/index.ts`,
  },
];

export function chronicleVitestConfig(overrides: UserConfig['test'] = {}): UserConfig {
  return {
    resolve: { alias: chronicleAliases },
    test: {
      include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
      passWithNoTests: true,
      ...overrides,
    },
  };
}
