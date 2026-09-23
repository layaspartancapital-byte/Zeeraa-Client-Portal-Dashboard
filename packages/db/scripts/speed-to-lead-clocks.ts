/**
 * Speed to lead on the 24/7 clock and on the desk's hours, side by side.
 *
 * The evidence for a change of clock: the same leads, the same first calls,
 * the same `speedToLead` from core, and only the clock differs. The query is
 * the one `callReport` runs — outbound, abandoned excluded, the first call
 * after the lead was created — so what this prints is what the card will show.
 *
 * Read-only, and safe against production:
 *
 *   ( set -a; . ./.env.neon; set +a
 *     DATABASE_URL_MAINT="$DATABASE_URL_MAINT" \
 *       pnpm --filter @zeeraa/db exec tsx scripts/speed-to-lead-clocks.ts )
 *
 * The hours come from the tenant's `lead_response_hours` row. Where there is
 * none yet — before the row is loaded — the seed's is used and the output says
 * so, which is what makes this the before-and-after for a deploy that has not
 * happened.
 */
import postgres from 'postgres';
import {
  addDays,
  formatDuration,
  parseBusinessHours,
  responseSeconds,
  speedToLead,
  tenantDay,
  type BusinessHours,
  type SpeedToLead,
} from '@zeeraa/core';
import { spartan } from '../seeds/spartan';

const url = process.env.DATABASE_URL_MAINT;
if (!url) {
  console.error('DATABASE_URL_MAINT is not set. Source .env for local, .env.neon for production.');
  process.exit(1);
}

const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const sql = postgres(url, { max: 1, onnotice: () => {} });

type Pair = { createdOn: string; created: Date; firstCall: Date };

function row(label: string, s: SpeedToLead) {
  return {
    clock: label,
    called: s.called,
    median: formatDuration(s.medianSeconds),
    p90: formatDuration(s.p90Seconds),
    'within 5 min': s.withinFiveMinutesShare === null
      ? '—'
      : `${(s.withinFiveMinutesShare * 100).toFixed(1)}% (${s.withinFiveMinutes})`,
  };
}

async function main(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.maintenance', 'on', true)`;

    const [tenant] = await tx<{ id: string; timezone: string }[]>`
      select id, timezone from tenants where slug = ${slug}`;
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [config] = await tx<{ value: unknown }[]>`
      select value from tenant_config
      where tenant_id = ${tenant.id} and key = 'lead_response_hours'`;
    let hours: BusinessHours | null = parseBusinessHours(config?.value);
    let source = 'tenant_config';
    if (hours === null) {
      hours = parseBusinessHours(spartan.config.find((c) => c.key === 'lead_response_hours')?.value);
      source = config ? 'seed (the tenant row does not parse)' : 'seed (no tenant row yet)';
    }
    if (hours === null) throw new Error('No readable lead_response_hours, in the tenant or the seed.');

    const rows = await tx<{ created_on: string; created: number; first_call: number }[]>`
      select to_char(l.created_on, 'YYYY-MM-DD') as created_on,
             extract(epoch from l.created_at)::float8 as created,
             extract(epoch from min(c.occurred_at))::float8 as first_call
      from leads l
      join calls c
        on c.tenant_id = l.tenant_id
       and c.lead_external_id = l.external_id
       and c.direction = 'outbound'
       and c.occurred_at > l.created_at
       and c.outcome <> 'abandoned'
      where l.tenant_id = ${tenant.id}
      group by l.external_id, l.created_at, l.created_on`;

    const pairs: Pair[] = rows.map((r) => ({
      createdOn: r.created_on,
      created: new Date(Number(r.created) * 1000),
      firstCall: new Date(Number(r.first_call) * 1000),
    }));

    const today = tenantDay(new Date(), tenant.timezone);
    const windows: { label: string; start: string | null }[] = [
      { label: 'Month to date', start: `${today.slice(0, 8)}01` },
      { label: 'Last 30 days', start: addDays(today, -29) },
      { label: 'Last 90 days', start: addDays(today, -89) },
      { label: 'Every called lead', start: null },
    ];

    console.log(`${slug}: hours from ${source}`);
    console.log(`  ${JSON.stringify(hours)}\n`);

    for (const w of windows) {
      const inWindow = pairs.filter((p) => w.start === null || (p.createdOn >= w.start && p.createdOn <= today));
      const on = (clock: BusinessHours | null) =>
        speedToLead(inWindow.map((p) => ({ seconds: responseSeconds(p.created, p.firstCall, clock) })), 0);
      console.log(`${w.label}${w.start ? ` (${w.start} to ${today})` : ''}`);
      console.table([row('24/7 (before)', on(null)), row('business hours (after)', on(hours))]);
    }

    // How many leads the change moves at all: only a wait that ran through
    // closed hours differs between the clocks.
    const crossed = pairs.filter(
      (p) => responseSeconds(p.created, p.firstCall, hours) < responseSeconds(p.created, p.firstCall, null),
    ).length;
    const zeroed = pairs.filter((p) => responseSeconds(p.created, p.firstCall, hours) === 0).length;
    console.log(
      `Every called lead: ${crossed} of ${pairs.length} waited through closed hours; ` +
        `${zeroed} were rung before the clock started and count as zero.`,
    );
  });
}

try {
  await main();
} finally {
  await sql.end();
}
