import { z } from 'zod';

/** Availability of a notice URL, driven by admin mutations. */
export type NoticeStatus = 'live' | 'removed_404' | 'removed_410' | 'soft_removed' | 'redirected';

export interface Notice {
  id: string;
  circularNo: string;
  title: string;
  department: string;
  scheme: string;
  printedDate: string; // YYYY-MM-DD
  deadline: string; // YYYY-MM-DD
  amountInr: number;
  amountUnit: string;
  /** Body paragraphs. Clause 0 is the eligibility clause that `edit_text` replaces. */
  clauses: string[];
  status: NoticeStatus;
  delisted: boolean;
  hiddenFromVantages: string[];
  /** Last content change (unix seconds); served as Last-Modified and used as the PDF ModDate. */
  updatedAt: number;
}

export const ACTIONS = [
  'edit_deadline',
  'edit_amount',
  'edit_text',
  'remove_404',
  'remove_410',
  'soft_remove',
  'redirect',
  'delist',
  'restore',
  'backdate',
  'hide_from_vantage',
] as const;
export type Action = (typeof ACTIONS)[number];

export const MutateBody = z.object({
  id: z.string().regex(/^\d{3}$/),
  action: z.enum(ACTIONS),
  value: z.string().max(2000).optional(),
});
export type MutateBody = z.infer<typeof MutateBody>;

export class MutationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'MutationError';
  }
}

/** Default shift for `backdate` without a value. */
export const BACKDATE_DEFAULT_DAYS = 45;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const VANTAGE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Entirely synthetic notices. Names, numbers and schemes are invented. */
export function seedNotices(updatedAt: number): Notice[] {
  const base = { status: 'live' as const, delisted: false, updatedAt };
  const notices: Omit<Notice, 'hiddenFromVantages'>[] = [
    {
      ...base,
      id: '001',
      circularNo: 'DEMO/2026/01',
      title: 'Demo Merit Scholarship 2026: call for applications',
      department: 'Department of Synthetic Higher Education',
      scheme: 'Demo Merit Scholarship',
      printedDate: '2026-10-01',
      deadline: '2026-10-30',
      amountInr: 1500,
      amountUnit: 'per month',
      clauses: [
        'Students enrolled full time in a recognised demo institution with at least 60 percent marks in the previous year are eligible.',
        'Applications must be submitted through the demo scholarship portal together with a fee receipt and an institution certificate.',
        'Selected students will receive the scholarship for ten months of the academic year, paid directly to a bank account.',
      ],
    },
    {
      ...base,
      id: '002',
      circularNo: 'DEMO/2026/02',
      title: 'Demo Seed Subsidy for the rabi season',
      department: 'Department of Synthetic Agriculture',
      scheme: 'Demo Seed Subsidy',
      printedDate: '2026-10-05',
      deadline: '2026-11-15',
      amountInr: 25000,
      amountUnit: 'per hectare',
      clauses: [
        'Farmers holding up to two hectares of cultivable land registered in the demo land records are eligible.',
        'The subsidy covers certified seed purchased from an authorised demo seed outlet during the rabi season.',
        'Claims must include the purchase invoice and the land record extract and are verified by the block office.',
      ],
    },
    {
      ...base,
      id: '003',
      circularNo: 'DEMO/2026/03',
      title: 'Demo Rental Assistance for urban households',
      department: 'Department of Synthetic Urban Housing',
      scheme: 'Demo Rental Assistance',
      printedDate: '2026-10-10',
      deadline: '2026-12-01',
      amountInr: 4000,
      amountUnit: 'per month',
      clauses: [
        'Households renting a home in a demo municipal area with an annual income below the notified limit are eligible.',
        'Assistance is paid for up to twelve months against a registered rent agreement and monthly rent receipts.',
        'Applications are accepted at the demo ward office or through the demo housing portal.',
      ],
    },
  ];
  return notices.map((n) => ({ ...n, hiddenFromVantages: [] }));
}

/** In-memory state for the demo site. `now` returns unix seconds. */
export class DemoState {
  private notices = new Map<string, Notice>();
  private visitorCount = 0;

  constructor(private readonly now: () => number) {
    this.reset();
  }

  reset(): void {
    this.notices = new Map(seedNotices(this.now()).map((n) => [n.id, n]));
    this.visitorCount = 1000;
  }

  /** Volatile on purpose: increments on every page view. */
  nextVisitor(): number {
    this.visitorCount += 1;
    return this.visitorCount;
  }

  get(id: string): Notice | undefined {
    return this.notices.get(id);
  }

  list(): Notice[] {
    return [...this.notices.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshot(): { notices: Notice[]; visitors: number } {
    return { notices: structuredClone(this.list()), visitors: this.visitorCount };
  }

  mutate(body: MutateBody): Notice {
    const n = this.notices.get(body.id);
    if (!n) throw new MutationError(404, `no notice ${body.id}`);
    const value = body.value?.trim() ?? '';
    const touch = (): void => {
      n.updatedAt = this.now();
    };

    switch (body.action) {
      case 'edit_deadline':
        if (!isIsoDate(value)) throw new MutationError(400, 'edit_deadline needs a YYYY-MM-DD value');
        n.deadline = value;
        touch();
        break;
      case 'edit_amount': {
        const amount = Number(value.replace(/,/g, ''));
        if (value === '' || !Number.isFinite(amount) || amount < 0 || amount > 1e9) {
          throw new MutationError(400, 'edit_amount needs a non-negative rupee value');
        }
        n.amountInr = amount;
        touch();
        break;
      }
      case 'edit_text':
        if (value.length < 10) throw new MutationError(400, 'edit_text needs replacement clause text');
        n.clauses[0] = value.replace(/\s+/g, ' ');
        touch();
        break;
      case 'backdate': {
        const date = value === '' ? shiftDate(n.printedDate, -BACKDATE_DEFAULT_DAYS) : value;
        if (!isIsoDate(date)) throw new MutationError(400, 'backdate needs a YYYY-MM-DD value or none');
        n.printedDate = date;
        touch();
        break;
      }
      case 'remove_404':
        n.status = 'removed_404';
        break;
      case 'remove_410':
        n.status = 'removed_410';
        break;
      case 'soft_remove':
        n.status = 'soft_removed';
        break;
      case 'redirect':
        n.status = 'redirected';
        break;
      case 'delist':
        n.delisted = true;
        break;
      case 'hide_from_vantage': {
        const v = value.toLowerCase();
        if (!VANTAGE_RE.test(v)) throw new MutationError(400, 'hide_from_vantage needs a vantage label');
        if (!n.hiddenFromVantages.includes(v)) n.hiddenFromVantages.push(v);
        break;
      }
      case 'restore':
        n.status = 'live';
        n.delisted = false;
        n.hiddenFromVantages = [];
        break;
    }
    return structuredClone(n);
  }
}
