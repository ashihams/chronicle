import type { Logger } from 'pino';
import {
  decideAlertStage,
  formatAlertMessage,
  MAX_ALERTS_PER_CHAT_PER_HOUR,
  timelineUrl,
} from './alerts.js';
import {
  createIndexerClient,
  currentVersion,
  maxOpenSeverity,
  type DocDetail,
  type DocListItem,
  type IndexerClient,
} from './api-client.js';
import type { BotDb } from './db.js';
import { matchingChatIds } from './subscriptions.js';

export const POLL_INTERVAL_MS = 60_000;
const META_CURSOR = 'changed_since_cursor';

export type SendAlert = (chatId: number, text: string) => Promise<void>;

export interface DispatcherOptions {
  db: BotDb;
  apiBaseUrl: string;
  send: SendAlert;
  log: Logger;
  client?: IndexerClient;
  now?: () => number;
  /** When set, only process these list items (tests). */
  pollOnce?: boolean;
}

export interface DispatcherHandle {
  stop: () => void;
  /** Runs one poll cycle (also used by the interval). */
  tick: () => Promise<{ considered: number; sent: number }>;
}

function changeLine(detail: DocDetail, list: DocListItem): string {
  const summary = currentVersion(detail)?.summary_en ?? list.current_version?.summary_en;
  if (summary !== null && summary !== undefined && summary.trim() !== '') return summary.trim().slice(0, 160);
  const state = detail.status.current_state ?? list.current_state ?? 'changed';
  return `state ${state}`;
}

/**
 * Polls `/api/docs?changed_since=` and sends two-stage alerts to matching subscribers.
 * Never logs chat IDs or filter values.
 */
export function startDispatcher(opts: DispatcherOptions): DispatcherHandle {
  const client = opts.client ?? createIndexerClient(opts.apiBaseUrl);
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (): Promise<{ considered: number; sent: number }> => {
    if (running) return { considered: 0, sent: 0 };
    running = true;
    let considered = 0;
    let sent = 0;
    try {
      const cursorRaw = opts.db.getMeta(META_CURSOR);
      const cursor = cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : Math.max(0, now() - 3600);
      const items = await client.listChangedSince(cursor, 200);
      const subs = opts.db.allSubscriptions();
      let highWater = cursor;

      for (const item of items) {
        considered += 1;
        if (item.last_change_ts !== null && item.last_change_ts > highWater) highWater = item.last_change_ts;

        const chats = matchingChatIds(
          {
            doc_id: item.doc_id,
            notice_id: item.notice_id,
            title: item.title,
            department: item.department,
            scheme: item.scheme,
            summary_en: item.current_version?.summary_en ?? null,
          },
          subs,
        );
        if (chats.length === 0) continue;

        let detail: DocDetail;
        try {
          detail = await client.getDoc(item.doc_id);
        } catch (err) {
          opts.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'dispatcher: doc fetch failed',
          );
          continue;
        }

        const ver = currentVersion(detail);
        if (ver === null) continue;
        const severity = maxOpenSeverity(detail);
        const observerCount = ver.observer_count > 0 ? ver.observer_count : detail.observers.length;
        const stage = decideAlertStage({ severity, observerCount });
        if (stage === null) continue;

        const text = formatAlertMessage({
          stage,
          department: item.department ?? detail.doc.department ?? 'unknown',
          title: item.title ?? detail.doc.title ?? item.notice_id ?? 'Untitled',
          changeLine: changeLine(detail, item),
          severity: Math.max(severity, stage === 'confirmed' ? 2 : severity),
          observerCount,
          firstSeenTs: ver.first_seen_ts,
          timelineUrl: timelineUrl(opts.apiBaseUrl, item.doc_id),
        });

        for (const chatId of chats) {
          if (opts.db.wasAlerted(chatId, item.doc_id, ver.norm_sha256, stage)) continue;
          const hourAgo = now() - 3600;
          if (opts.db.alertsInWindow(chatId, hourAgo) >= MAX_ALERTS_PER_CHAT_PER_HOUR) {
            opts.log.info({ stage }, 'dispatcher: chat hourly alert cap reached');
            continue;
          }
          try {
            await opts.send(chatId, text);
            opts.db.recordAlert(chatId, item.doc_id, ver.norm_sha256, stage, now());
            sent += 1;
          } catch (err) {
            opts.log.warn({ err: err instanceof Error ? err.message : String(err), stage }, 'dispatcher: send failed');
          }
        }
      }

      if (highWater > cursor) opts.db.setMeta(META_CURSOR, String(highWater));
      opts.log.info({ considered, sent, cursor: highWater }, 'dispatcher poll');
    } catch (err) {
      opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'dispatcher poll failed');
    } finally {
      running = false;
    }
    return { considered, sent };
  };

  if (!opts.pollOnce) {
    timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    void tick();
  }

  return {
    tick,
    stop: (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
