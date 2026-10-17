import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Config } from '@chronicle/core';
import type { Logger } from 'pino';
import { createChronicleBot } from './bot.js';
import { BotDb } from './db.js';
import { startDispatcher, type DispatcherHandle } from './dispatcher.js';

export interface BotHandle {
  stop: () => Promise<void>;
}

export async function startBot(opts: { config: Config; baseDir: string; log: Logger }): Promise<BotHandle> {
  const token = opts.config.bot.telegramBotToken;
  if (token === undefined || token.trim() === '') {
    throw new Error('TELEGRAM_BOT_TOKEN is required to run the bot');
  }

  const dbPath = isAbsolute(opts.config.bot.dbPath)
    ? opts.config.bot.dbPath
    : join(opts.baseDir, opts.config.bot.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BotDb(dbPath);

  const bot = createChronicleBot({ token, db, log: opts.log });
  let dispatcher: DispatcherHandle | null = null;

  dispatcher = startDispatcher({
    db,
    apiBaseUrl: opts.config.bot.apiBaseUrl,
    log: opts.log,
    send: async (chatId, text) => {
      await bot.api.sendMessage(chatId, text);
    },
  });

  await bot.start({
    onStart: () => {
      opts.log.info('telegram bot polling');
    },
  });

  return {
    stop: async (): Promise<void> => {
      dispatcher?.stop();
      await bot.stop();
      db.close();
    },
  };
}
