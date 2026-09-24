import { and, count, eq, sql } from 'drizzle-orm';
import { formatCount, formatRate } from '@zeeraa/core';
import { leadsCreatedIn, schema, submissionsIn } from '@zeeraa/db';
import { queryTenant, type TenantSession } from '@/lib/tenant';

type DayRange = { start: string; end: string };

/**
 * Why lenders declined, from the best-populated field for it (24 September
 * 2026): `Decline_Reason__c` on the lender submission, 13.1% of submissions
 * since June by a value sweep across Lead, Opportunity and
 * csbs__Submission__c. Opportunity `Loss_Reason__c` holds 2.6% and nothing
 * else holds a reason at all.
 *
 * Counted per declined submission. A decline with one or more reasons counts
 * once under each; a decline with none is its own bucket, "Declined by
 * Lenders", rather than being left out — most declines carry no reason, and
 * the reasons are only honest beside how many they cover.
 */
export type DeclineReasonSummary = {
  declined: number;
  withReason: number;
  reasons: { label: string; count: number }[];
  /** Declines a lender made without recording why. */
  noReason: number;
};

export const NO_REASON_BUCKET = 'Declined by Lenders';

export async function declineReasonSummary(session: TenantSession, range: DayRange): Promise<DeclineReasonSummary> {
  return queryTenant(session, async (tx) => {
    const declinedWhere = and(
      eq(schema.submissions.tenantId, session.tenant.id),
      eq(schema.submissions.outcome, 'declined'),
      submissionsIn(range),
    );
    const [totals] = await tx
      .select({
        declined: count(),
        withReason: sql<number>`count(*) filter (where cardinality(coalesce(${schema.submissions.declineReasons}, '{}')) > 0)`,
      })
      .from(schema.submissions)
      .where(declinedWhere);
    const reasons = await tx
      .select({ label: sql<string>`r.reason`, count: sql<number>`count(*)` })
      .from(sql`${schema.submissions}, unnest(${schema.submissions.declineReasons}) as r(reason)`)
      .where(declinedWhere)
      .groupBy(sql`r.reason`)
      .orderBy(sql`count(*) desc`, sql`r.reason`);
    const declined = Number(totals?.declined ?? 0);
    const withReason = Number(totals?.withReason ?? 0);
    return {
      declined,
      withReason,
      reasons: reasons.map((r) => ({ label: r.label, count: Number(r.count) })),
      noReason: declined - withReason,
    };
  });
}

/**
 * Inbound leads by monthly revenue, in the tenant's one merged set of bands
 * (`leads.revenue_band`, migration 0034). Coverage is part of the figure:
 * how many leads are in a band, how many gave an answer that spans two, how
 * many said New Business, and how many answered nothing.
 */
export type RevenueBandSummary = {
  leads: number;
  bands: { key: string; label: string; count: number }[];
  placed: number;
  spansBands: number;
  categorical: number;
  unanswered: number;
};

export async function revenueBandSummary(session: TenantSession, range: DayRange): Promise<RevenueBandSummary> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select({ band: schema.leads.revenueBand, n: count() })
      .from(schema.leads)
      .where(and(eq(schema.leads.tenantId, session.tenant.id), leadsCreatedIn(range)))
      .groupBy(schema.leads.revenueBand),
  );
  const bands = rows
    .filter((r) => r.band !== null && !r.band.startsWith('unplaced:') && !r.band.startsWith('categorical:'))
    .map((r) => ({ key: r.band!, label: revenueBandLabel(r.band!), count: Number(r.n) }))
    .sort((a, b) => bandLower(a.key) - bandLower(b.key));
  const sum = (pred: (band: string | null) => boolean) =>
    rows.filter((r) => pred(r.band)).reduce((n, r) => n + Number(r.n), 0);
  return {
    leads: sum(() => true),
    bands,
    placed: bands.reduce((n, b) => n + b.count, 0),
    spansBands: sum((b) => b?.startsWith('unplaced:') ?? false),
    categorical: sum((b) => b?.startsWith('categorical:') ?? false),
    unanswered: sum((b) => b === null),
  };
}

function bandLower(key: string): number {
  if (key.startsWith('lt:')) return -1;
  if (key.startsWith('gte:')) return Number(key.slice(4));
  return Number(key.split('-')[0]);
}

/** `Under $10k`, `$10k–$20k`, `Over $100k`. */
export function revenueBandLabel(key: string): string {
  const k = (n: number) => `$${n >= 1000 ? `${n / 1000}k` : n}`;
  if (key.startsWith('lt:')) return `Under ${k(Number(key.slice(3)))}`;
  if (key.startsWith('gte:')) return `Over ${k(Number(key.slice(4)))}`;
  const [lo, hi] = key.split('-').map(Number);
  return `${k(lo!)}–${k(hi!)}`;
}

/** The share, written for a client: `38.2%`. Null where there is no base. */
export function share(n: number, of: number): string | null {
  return of > 0 ? formatRate(n / of) : null;
}

export function reasonLine(summary: DeclineReasonSummary, top = 3): string {
  const parts = summary.reasons.slice(0, top).map((r) => `${r.label} (${formatCount(r.count)})`);
  return parts.join(', ');
}

/**
 * The offer rate at the grain the decision is made: each lender's offers over
 * its offers plus declines (the live `lender_offer_rate`). Submissions still
 * waiting on a lender's reply are in neither.
 */
export type OfferRateSummary = {
  offered: number;
  decided: number;
  waiting: number;
  lenders: { name: string; offered: number; decided: number }[];
};

export async function offerRateSummary(session: TenantSession, range: DayRange): Promise<OfferRateSummary> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select({
        name: sql<string>`coalesce(${schema.submissions.lenderName}, 'Lender not named')`,
        offered: sql<number>`count(*) filter (where ${schema.submissions.outcome} = 'offered')`,
        declined: sql<number>`count(*) filter (where ${schema.submissions.outcome} = 'declined')`,
        waiting: sql<number>`count(*) filter (where ${schema.submissions.outcome} = 'undecided')`,
      })
      .from(schema.submissions)
      .where(and(eq(schema.submissions.tenantId, session.tenant.id), submissionsIn(range)))
      .groupBy(sql`1`),
  );
  const lenders = rows
    .map((r) => ({ name: r.name, offered: Number(r.offered), decided: Number(r.offered) + Number(r.declined) }))
    .sort((a, b) => b.decided - a.decided);
  return {
    offered: lenders.reduce((n, l) => n + l.offered, 0),
    decided: lenders.reduce((n, l) => n + l.decided, 0),
    waiting: rows.reduce((n, r) => n + Number(r.waiting), 0),
    lenders,
  };
}
