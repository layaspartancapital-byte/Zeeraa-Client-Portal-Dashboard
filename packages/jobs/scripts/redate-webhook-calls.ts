/**
 * Re-dates webhook calls written while `Created At` was read in the tenant's
 * zone instead of UTC (fixed 23 September 2026).
 *
 *   pnpm --filter @zeeraa/jobs redate-webhook-calls <slug> --written-before <ISO instant> --dry-run
 *   pnpm --filter @zeeraa/jobs redate-webhook-calls <slug> --written-before <ISO instant>
 *
 * The stored instant is the payload's wall clock read as tenant-local time;
 * the right instant is the same wall clock read as UTC. So each row's wall
 * clock is recovered in the tenant's zone and re-read as UTC — correct across a
 * DST change, which a flat four hours would not be — and `occurred_on`, the
 * tenant-local day, is recomputed from the corrected instant.
 *
 * **It must never apply twice.** Only webhook rows last written before
 * `--written-before` (the deploy that fixed the parser) are touched, and each
 * re-dated row's `updated_at` moves to now, so a second run finds nothing and a
 * call re-delivered after the fix — already correct — is left alone.
 *
 * Writes on the ingestion role, scoped to the tenant, like the import.
 * `--dry-run` computes everything inside a transaction and rolls it back.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { parseWallClock, tenantDay } from '@zeeraa/core';

const args = process.argv.slice(2);
const slug = args[0];
const beforeIndex = args.indexOf('--written-before');
const before = beforeIndex === -1 ? null : new Date(args[beforeIndex + 1] ?? '');
const dryRun = args.includes('--dry-run');
if (!slug || !before || Number.isNaN(before.getTime())) {
  throw new Error('Usage: redate-webhook-calls <slug> --written-before <ISO instant> [--dry-run]');
}

class Rollback extends Error {}

function span(instants: Date[]): string {
  if (instants.length === 0) return '—';
  const sorted = [...instants].sort((a, b) => a.getTime() - b.getTime());
  return `${sorted[0]!.toISOString()} → ${sorted.at(-1)!.toISOString()}`;
}

/** `YYYY-MM-DD HH:MM:SS` of an instant in a zone: the wall clock it was parsed from. */
function wallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const [tenant] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx.select({ id: schema.tenants.id, tz: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.slug, slug)),
);
if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

let report: string[] = [];
try {
  await withJobTenant(tenant.id, async (tx) => {
    const rows = await tx
      .select({ id: schema.calls.id, occurredAt: schema.calls.occurredAt, occurredOn: schema.calls.occurredOn })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.tenantId, tenant.id),
          eq(schema.calls.source, 'webhook'),
          lt(schema.calls.updatedAt, before),
        ),
      );

    const now = new Date();
    let dayChanged = 0;
    const stored: Date[] = [];
    const fixed: Date[] = [];
    for (const row of rows) {
      const corrected = parseWallClock(wallClock(row.occurredAt, tenant.tz), 'UTC')!;
      const day = tenantDay(corrected, tenant.tz);
      if (day !== String(row.occurredOn)) dayChanged += 1;
      stored.push(row.occurredAt);
      fixed.push(corrected);
      await tx
        .update(schema.calls)
        .set({ occurredAt: corrected, occurredOn: day, updatedAt: now })
        .where(eq(schema.calls.id, row.id));
    }

    // Read back inside the transaction: under FORCE a denied write matches
    // nothing and says nothing.
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.calls)
      .where(and(eq(schema.calls.tenantId, tenant.id), eq(schema.calls.source, 'webhook'), lt(schema.calls.updatedAt, before)));
    if (Number(left?.n ?? 0) !== 0) {
      throw new Error(`Refusing to commit: ${left?.n} rows still carry the old time — the write did not land.`);
    }

    report = [
      `${rows.length} webhook calls written before ${before.toISOString()}`,
      `  stored:    ${span(stored)}`,
      `  corrected: ${span(fixed)}`,
      `  tenant-local day changed on ${dayChanged}`,
    ];
    if (dryRun) throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}
console.log(report.join('\n'));
console.log(dryRun ? 'Dry run: rolled back, nothing changed.' : 'Committed.');
process.exit(0);
