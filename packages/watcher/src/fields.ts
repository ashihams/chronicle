import type { NoticeFields } from '@chronicle/core';
import { z } from 'zod';

/** Validates `last_fields_json` read back from the local DB. */
export const NoticeFieldsSchema: z.ZodType<NoticeFields> = z.object({
  title: z.string().nullable(),
  department: z.string().nullable(),
  scheme: z.string().nullable(),
  printed_date_ts: z.number().int().nonnegative().nullable(),
  deadline_ts: z.number().int().nonnegative().nullable(),
  deadline_date: z.string().nullable(),
  amount_paise: z.number().int().nonnegative().nullable(),
  declared_supersedes: z.string().nullable(),
  summary_en: z.string(),
});

export type { NoticeFields };
