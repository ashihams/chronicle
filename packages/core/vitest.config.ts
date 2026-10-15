import { defineConfig } from 'vitest/config';
import { chronicleVitestConfig } from '../../vitest.shared';

export default defineConfig(
  chronicleVitestConfig({
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 85 },
    },
  }),
);
