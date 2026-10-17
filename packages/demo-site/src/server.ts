import { fileURLToPath } from 'node:url';
import { loadConfig } from '@chronicle/core';
import { buildDemoApp } from './app.js';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env file: rely on the environment
}

const config = loadConfig(process.env);
const { app } = buildDemoApp({ adminToken: config.demo.adminToken, logger: { level: 'info' } });
if (config.demo.adminToken === 'change-me') {
  app.log.warn('DEMO_ADMIN_TOKEN is the default value; set it before exposing the demo site');
}
await app.listen({ port: config.demo.port, host: '0.0.0.0' });
