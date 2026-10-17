import { Bot, type Context } from 'grammy';
import type { Logger } from 'pino';
import type { BotDb } from './db.js';
import { parseFollowArgs } from './subscriptions.js';

export interface ChronicleBotOptions {
  token: string;
  db: BotDb;
  log: Logger;
  now?: () => number;
}

const HELP = [
  'Chronicle follow-and-alert (stretch S4)',
  '',
  '/follow <department|scheme|doc_id|keyword> <value> — subscribe to changes',
  '/follow <64-hex> — shorthand for a document id',
  '/unfollow <type> <value> — remove a subscription',
  '/list — show your subscriptions',
  '/help — this message',
  '',
  'Subscriptions are stored only on this bot (never on Arkiv). Alerts:',
  'UNCONFIRMED when one watcher reports a high-severity change;',
  'CONFIRMED when 2+ watchers agree on the same content hash.',
  'Max 5 alerts per chat per hour.',
].join('\n');

/**
 * Grammy bot with follow/unfollow/list. Does not log chat IDs or filter values.
 */
export function createChronicleBot(opts: ChronicleBotOptions): Bot {
  const bot = new Bot(opts.token);
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));

  bot.command('start', async (ctx) => {
    await ctx.reply(HELP);
    opts.log.info({ event: 'command', name: 'start' }, 'bot command');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP);
    opts.log.info({ event: 'command', name: 'help' }, 'bot command');
  });

  bot.command('follow', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const parsed = parseFollowArgs(commandPayload(ctx));
    if ('error' in parsed) {
      await ctx.reply(parsed.error);
      return;
    }
    const added = opts.db.addSubscription(chatId, parsed.filterType, parsed.filterValue, now());
    await ctx.reply(
      added
        ? `Following ${parsed.filterType}=${parsed.filterValue}.`
        : `Already following ${parsed.filterType}=${parsed.filterValue}.`,
    );
    opts.log.info({ event: 'command', name: 'follow', added }, 'bot command');
  });

  bot.command('unfollow', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const parsed = parseFollowArgs(commandPayload(ctx));
    if ('error' in parsed) {
      await ctx.reply(parsed.error);
      return;
    }
    const removed = opts.db.removeSubscription(chatId, parsed.filterType, parsed.filterValue);
    await ctx.reply(
      removed
        ? `Unfollowed ${parsed.filterType}=${parsed.filterValue}.`
        : `No subscription for ${parsed.filterType}=${parsed.filterValue}.`,
    );
    opts.log.info({ event: 'command', name: 'unfollow', removed }, 'bot command');
  });

  bot.command('list', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const subs = opts.db.listSubscriptions(chatId);
    if (subs.length === 0) {
      await ctx.reply('No subscriptions. Use /follow to add one.');
    } else {
      const lines = subs.map((s) => `• ${s.filterType}=${s.filterValue}`);
      await ctx.reply(`Your subscriptions (${subs.length}):\n${lines.join('\n')}`);
    }
    opts.log.info({ event: 'command', name: 'list', count: subs.length }, 'bot command');
  });

  bot.catch((err) => {
    opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bot error');
  });

  return bot;
}

function commandPayload(ctx: Context): string {
  const text = ctx.message?.text ?? '';
  const parts = text.split(/\s+/);
  return parts.slice(1).join(' ');
}
