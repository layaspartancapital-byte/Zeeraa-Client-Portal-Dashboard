/**
 * What the qualification bar can actually be evaluated against, per month.
 *
 * Two questions, and the gap between them is the finding:
 *
 *   **populated** — the lead carries *something* in one of the candidate
 *   fields; and
 *   **usable** — that something resolves to a verdict against the bar rather
 *   than to a straddling band, a categorical label or a code.
 *
 * A field can be 53% populated and contribute nothing, which is exactly what
 * `MIYB_Years_in_Business__c` did for months. Reporting only population would
 * have called that coverage.
 *
 *   SF_CLIENT_ID=… SF_USERNAME=… SF_PRIVATE_KEY_BASE64=… SF_LOGIN_URL=… \
 *   MQL_BAR='{"minMonthlyRevenue":10000,"minMonthsInBusiness":12}' \
 *   LEAD_EXCLUSION='{…}' FIELD_MAPPING='{…}' \
 *   pnpm --filter @zeeraa/connectors qualification-coverage
 *
 * Read-only. It reads leads and computes; it writes nothing to the org.
 */
import { judgeBand, readDurationBand, readMoneyBand } from '@zeeraa/core';
import { SalesforceClient } from '../src/salesforce/client';
import { inboundClause, parseLeadExclusion } from '../src/salesforce/exclusion';
import { timeInBusinessCandidates, type SalesforceFieldMapping } from '../src/salesforce/mapping';

const required = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_PRIVATE_KEY_BASE64', 'SF_LOGIN_URL'] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Cannot run: ${missing.join(', ')} not set.`);
  process.exit(2);
}

const bar = JSON.parse(process.env.MQL_BAR ?? '{}') as {
  minMonthlyRevenue: number;
  minMonthsInBusiness: number;
};
const mapping = JSON.parse(process.env.FIELD_MAPPING ?? '{}') as SalesforceFieldMapping;
const clause = inboundClause(parseLeadExclusion(JSON.parse(process.env.LEAD_EXCLUSION ?? '{}')));

const revenue = mapping.lead?.revenueBands ?? [];
const duration = timeInBusinessCandidates(mapping);
if (revenue.length === 0 || duration.length === 0) {
  console.error('The field mapping carries no revenue or time-in-business candidates.');
  process.exit(2);
}

const client = new SalesforceClient({
  clientId: process.env.SF_CLIENT_ID!,
  username: process.env.SF_USERNAME!,
  privateKeyBase64: process.env.SF_PRIVATE_KEY_BASE64!,
  loginUrl: process.env.SF_LOGIN_URL!,
});

const fields = ['Id', 'CreatedDate', ...revenue.map((r) => r.field), ...duration.map((d) => d.field)];
const rows = await client.query<Record<string, unknown>>(
  `SELECT ${[...new Set(fields)].join(',')} FROM Lead${clause ? ` WHERE ${clause}` : ''}`,
);

const text = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
type Tally = { n: number; revAny: number; revOk: number; durAny: number; durOk: number; bothOk: number };
const months = new Map<string, Tally>();
const answered = { revenue: new Map<string, number>(), duration: new Map<string, number>() };

for (const row of rows) {
  const month = String(row.CreatedDate).slice(0, 7);
  const t = months.get(month) ?? { n: 0, revAny: 0, revOk: 0, durAny: 0, durOk: 0, bothOk: 0 };
  t.n += 1;

  let revAny = false;
  let revOk: string | null = null;
  for (const c of revenue) {
    const raw = text(row[c.field]);
    if (!raw) continue;
    revAny = true;
    // `false` for a categorical, matching the bar: `New Business` is not an
    // amount, and a business that has not started trading has no revenue.
    if (
      revOk === null &&
      judgeBand(readMoneyBand(raw, c.period), bar.minMonthlyRevenue, false).meets !== null
    ) {
      revOk = c.field;
    }
  }

  let durAny = false;
  let durOk: string | null = null;
  for (const c of duration) {
    const raw = text(row[c.field]);
    if (!raw) continue;
    durAny = true;
    // `false` for a categorical: a business that has not started trading has no
    // trading history, which fails a minimum duration outright.
    if (
      durOk === null &&
      judgeBand(readDurationBand(raw, c.unit), bar.minMonthsInBusiness, false).meets !== null
    ) {
      durOk = c.field;
    }
  }

  if (revAny) t.revAny += 1;
  if (revOk) {
    t.revOk += 1;
    answered.revenue.set(revOk, (answered.revenue.get(revOk) ?? 0) + 1);
  }
  if (durAny) t.durAny += 1;
  if (durOk) {
    t.durOk += 1;
    answered.duration.set(durOk, (answered.duration.get(durOk) ?? 0) + 1);
  }
  if (revOk && durOk) t.bothOk += 1;
  months.set(month, t);
}

const pct = (a: number, b: number) => `${(b ? (a / b) * 100 : 0).toFixed(1)}%`.padStart(7);
console.log(`\nInbound leads: ${rows.length.toLocaleString()}`);
console.log(`Bar: $${bar.minMonthlyRevenue.toLocaleString()} monthly, ${bar.minMonthsInBusiness} months\n`);
console.log('month      leads  revenue populated  revenue usable   duration populated  duration usable   both usable');

const total: Tally = { n: 0, revAny: 0, revOk: 0, durAny: 0, durOk: 0, bothOk: 0 };
for (const month of [...months.keys()].sort()) {
  const t = months.get(month)!;
  for (const k of Object.keys(total) as (keyof Tally)[]) total[k] += t[k];
  console.log(
    `${month} ${String(t.n).padStart(7)} ${pct(t.revAny, t.n)}          ${pct(t.revOk, t.n)}` +
      `        ${pct(t.durAny, t.n)}           ${pct(t.durOk, t.n)}        ${pct(t.bothOk, t.n)}`,
  );
}
console.log(
  `TOTAL  ${String(total.n).padStart(7)} ${pct(total.revAny, total.n)}          ${pct(total.revOk, total.n)}` +
    `        ${pct(total.durAny, total.n)}           ${pct(total.durOk, total.n)}        ${pct(total.bothOk, total.n)}`,
);

for (const [concept, counts] of [['revenue', answered.revenue], ['time in business', answered.duration]] as const) {
  console.log(`\nwhich field answered ${concept}:`);
  const ordered = [...counts].sort((a, b) => b[1] - a[1]);
  if (ordered.length === 0) console.log('   nothing resolved');
  for (const [field, n] of ordered) console.log(`   ${String(n).padStart(6)}  ${field}`);
}

// The gap between populated and usable, which is the number worth acting on.
console.log(
  `\nPopulated but unusable: revenue ${total.revAny - total.revOk}, ` +
    `time in business ${total.durAny - total.durOk}.`,
);
