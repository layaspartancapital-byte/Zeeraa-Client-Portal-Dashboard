/**
 * Aloware's own webhook beside the Zap: what each sender delivered, whether
 * their copies of each call agree, and whether the Zap can be turned off.
 *
 * Read-only, and meant for production:
 *
 *   ( set -a; . ./.env.neon; set +a
 *     DATABASE_URL_MAINT="$DATABASE_URL_MAINT" \
 *       pnpm --filter @zeeraa/db aloware-senders [tenant-slug] [days] )
 *
 * The verdict is mechanical, so it can be re-run rather than re-argued. The
 * Zap can go when, over at least two complete open days on which Aloware
 * posted directly:
 *
 *   1. no direct post was refused,
 *   2. every call the Zap delivered, Aloware delivered too, and
 *   3. every call both delivered reads identically — time, direction,
 *      outcome, disposition and number — and its talk time and duration
 *      agree within ten seconds. The two senders read a call a moment apart,
 *      so a second or two of duration is noise; the outcome talk time decides
 *      is compared exactly. Smaller differences are listed, not counted.
 *
 * Then `configure-aloware <slug> --direct-mode live`, and the Zap off.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL_MAINT;
if (!url) {
  console.error('DATABASE_URL_MAINT is not set. Source .env for local, .env.neon for production.');
  process.exit(1);
}
const slug = process.argv[2] ?? 'spartan';
const days = Number(process.argv[3] ?? 14);
const sql = postgres(url, { max: 1, onnotice: () => {} });

const FIELDS = ['occurred_at', 'direction', 'outcome', 'disposition', 'talk_time_seconds', 'duration_seconds', 'contact_key'] as const;
/** Compared exactly: what any figure is computed from. */
const EXACT = ['occurred_at', 'direction', 'outcome', 'disposition', 'contact_key'] as const;
/** Seconds of talk time or duration the two copies may differ by. */
const TIMING_TOLERANCE = 10;

type Counts = { received: number; accepted: number; rejected: number; refused: number };

try {
  await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    await tx`select set_config('app.maintenance', 'on', true)`;

    const [tenant] = await tx<{ id: string; timezone: string }[]>`
      select id, timezone from tenants where slug = ${slug}`;
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const [today] = await tx<{ d: string }[]>`
      select to_char((now() at time zone ${tenant.timezone})::date, 'YYYY-MM-DD') as d`;
    const [config] = await tx<{ value: Record<string, unknown> }[]>`
      select value from tenant_config where tenant_id = ${tenant.id} and key = 'aloware'`;
    const mode = (config?.value?.directMode as string | undefined) ?? 'shadow';
    const [hoursRow] = await tx<{ value: { days?: string[]; holidays?: string[] } }[]>`
      select value from tenant_config where tenant_id = ${tenant.id} and key = 'lead_response_hours'`;
    const openDays = hoursRow?.value?.days ?? ['mon', 'tue', 'wed', 'thu', 'fri'];
    const holidays = hoursRow?.value?.holidays ?? [];
    const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const isOpen = (d: string) =>
      openDays.includes(WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]!) && !holidays.includes(d);

    console.log(`${slug}: Aloware direct webhook is in ${mode.toUpperCase()} mode. Today is ${today!.d}.\n`);

    // --- 1. Accepted vs refused, by sender ---------------------------------
    const buckets = await tx<{ d: string; senders: Record<string, Counts>; reasons: Record<string, number>; samples: Record<string, unknown> }[]>`
      select to_char("day", 'YYYY-MM-DD') as d, senders, reasons, samples
      from webhook_deliveries
      where tenant_id = ${tenant.id} and source = 'aloware'
        and "day" >= (now() at time zone ${tenant.timezone})::date - ${days}::int
      order by "day"`;
    const table = buckets.flatMap((b) =>
      ['zapier', 'aloware', 'unknown']
        .filter((s) => b.senders?.[s])
        .map((s) => ({ day: b.d, sender: s, ...b.senders[s]! })),
    );
    console.log('Deliveries by sender (accepted = finished calls the reader took; refused = never read):');
    if (table.length) console.table(table);
    else console.log('  none recorded per sender yet — counts by sender start with migration 0043.\n');
    const before = buckets.filter((b) => !b.senders || Object.keys(b.senders).length === 0);
    if (before.length) {
      console.log('Days before per-sender counting (all senders together):');
      console.table(before.map((b) => ({ day: b.d, reasons: JSON.stringify(b.reasons) })));
    }

    // --- 2. What the latest posts looked like -----------------------------
    const latest = [...buckets].reverse().find((b) => b.samples && Object.keys(b.samples).length > 0);
    if (latest) {
      console.log(`\nLatest redacted samples (${latest.d}):`);
      for (const [key, sample] of Object.entries(latest.samples)) {
        console.log(`  ${key}:`);
        console.log(`    ${JSON.stringify(sample, null, 2).replace(/\n/g, '\n    ')}`);
      }
    }

    // --- 3. Do the copies agree? ------------------------------------------
    const pairs = await tx<Record<string, unknown>[]>`
      with z as (select * from call_deliveries where tenant_id = ${tenant.id} and sender = 'zapier'),
           a as (select * from call_deliveries where tenant_id = ${tenant.id} and sender = 'aloware'),
           -- From the first call Aloware delivered directly, by the call's own
           -- time: which sender's copy arrived first does not matter.
           since as (select min(occurred_at) as t from a)
      select coalesce(z.external_id, a.external_id) as id,
             to_char(coalesce(z.occurred_at, a.occurred_at) at time zone ${tenant.timezone}, 'YYYY-MM-DD') as d,
             z.external_id is not null as by_zap, a.external_id is not null as by_aloware,
             ${sql.unsafe(FIELDS.map((f) => `(z.${f} is not distinct from a.${f}) as same_${f}`).join(', '))},
             extract(epoch from (a.occurred_at - z.occurred_at))::int as skew_seconds,
             greatest(abs(coalesce(a.talk_time_seconds, 0) - coalesce(z.talk_time_seconds, 0)),
                      abs(coalesce(a.duration_seconds, 0) - coalesce(z.duration_seconds, 0)))::int as timing_gap,
             a.agent_external_id as agent_id, a.agent_name as agent_name
      from z full join a on a.external_id = z.external_id
      where coalesce(z.occurred_at, a.occurred_at) >= (select t from since)`;

    const direct = pairs.filter((p) => p.by_aloware);
    if (direct.length === 0) {
      console.log('\nNo direct post has been accepted yet, so there is nothing to compare.');
      console.log('Verdict: KEEP THE ZAP. Aloware has not delivered a call directly.');
      return;
    }

    const complete = [...new Set(pairs.map((p) => p.d as string))]
      .filter((d) => d < today!.d && isOpen(d))
      .sort();
    const perDay = complete.map((d) => {
      const rows = pairs.filter((p) => p.d === d);
      const both = rows.filter((p) => p.by_zap && p.by_aloware);
      const mismatched = both.filter(
        (p) => EXACT.some((f) => !p[`same_${f}`]) || Number(p.timing_gap) > TIMING_TOLERANCE,
      );
      return {
        day: d,
        zap: rows.filter((p) => p.by_zap).length,
        aloware: rows.filter((p) => p.by_aloware).length,
        both: both.length,
        'zap only': rows.filter((p) => p.by_zap && !p.by_aloware).length,
        'aloware only': rows.filter((p) => !p.by_zap && p.by_aloware).length,
        mismatched: mismatched.length,
      };
    });
    console.log('\nCopies by call day, complete open days since the first direct post:');
    if (perDay.length) console.table(perDay);
    else console.log('  none complete yet — the first full day is the next open day.');

    const both = pairs.filter((p) => p.by_zap && p.by_aloware);
    const byField = Object.fromEntries(FIELDS.map((f) => [f, both.filter((p) => !p[`same_${f}`]).length]));
    console.log('\nFields that differ, of calls both delivered (all days):', byField);
    const small = both.filter(
      (p) => EXACT.every((f) => p[`same_${f}`]) && Number(p.timing_gap) > 0 && Number(p.timing_gap) <= TIMING_TOLERANCE,
    ).length;
    if (small) console.log(`  ${small} differ only in talk time or duration, by ${TIMING_TOLERANCE}s or less — listed, not counted against the Zap.`);
    const skews = both.map((p) => Number(p.skew_seconds)).filter((s) => s !== 0);
    if (skews.length) {
      const hours = [...new Set(skews.map((s) => Math.round(s / 3600)))];
      console.log(`  occurred_at differs on ${skews.length}; offsets in hours: ${hours.join(', ')} — a whole-hour offset is a zone mistake.`);
    }

    const unnamed = new Map<string, number>();
    for (const p of direct) {
      // Named now counts: a copy recorded before its id was mapped carries no name.
      const named = (config?.value?.agents as Record<string, string> | undefined)?.[String(p.agent_id)];
      if (p.agent_id && !p.agent_name && !named) unnamed.set(String(p.agent_id), (unnamed.get(String(p.agent_id)) ?? 0) + 1);
    }
    if (unnamed.size) {
      console.log('\nAgent ids with no name configured (configure-aloware --agent id=name):');
      console.table([...unnamed].map(([id, calls]) => ({ id, calls })));
    }

    // --- 4. The verdict ---------------------------------------------------
    const refusedOn = (d: string) =>
      buckets.find((b) => b.d === d)?.senders?.aloware?.refused ?? 0;
    const judged = perDay.filter((r) => r.aloware > 0);
    const failures: string[] = [];
    if (judged.length < 2) failures.push(`${judged.length} complete open day(s) of direct posts; need 2`);
    for (const r of judged) {
      if (refusedOn(r.day) > 0) failures.push(`${r.day}: ${refusedOn(r.day)} direct post(s) refused`);
      if (r['zap only'] > 0) failures.push(`${r.day}: ${r['zap only']} call(s) the Zap delivered and Aloware did not`);
      if (r.mismatched > 0) failures.push(`${r.day}: ${r.mismatched} call(s) whose copies differ beyond timing noise`);
    }

    console.log('');
    if (failures.length) {
      console.log('Verdict: KEEP THE ZAP.');
      for (const f of failures) console.log(`  - ${f}`);
    } else if (mode !== 'live') {
      console.log(`Verdict: READY. Over ${judged.length} complete days Aloware delivered every call the Zap did, matching on everything a figure reads, and nothing was refused.`);
      console.log(`  1. pnpm --filter @zeeraa/db configure-aloware ${slug} --direct-mode live   (with --dry-run first)`);
      console.log('  2. Turn the Zap off.');
    } else {
      console.log(`Verdict: TURN THE ZAP OFF. Aloware is live and has matched the Zap for ${judged.length} complete days.`);
    }
  });
} finally {
  await sql.end();
}
