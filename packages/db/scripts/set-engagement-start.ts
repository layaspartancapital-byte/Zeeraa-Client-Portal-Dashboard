/**
 * Records the month an engagement starts — M1 of its ramp — and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-engagement-start.ts 2026-10 --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-engagement-start.ts 2026-10
 *
 * Not `db:seed`, which rewrites every `tenant_config` row from the seed
 * constant. This touches the one row.
 *
 * Two safeguards:
 *
 *   * **`--dry-run` writes inside a transaction and rolls it back.** Under
 *     FORCE a denied write matches nothing and exits 0; the read-back inside
 *     the transaction is what proves it landed.
 *   * **It will not move a start month that is already recorded** without
 *     `--replace`. Once M1 is set, every ramp actual is aligned to it, and
 *     moving it silently would restate every month of the engagement.
 */
import { and, eq } from 'drizzle-orm';
import { isMonthKey } from '@zeeraa/core';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const month = process.argv.slice(2).find((a) => !a.startsWith('--'));
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const KEY = 'engagement_start_month';

if (!month || !isMonthKey(month)) {
  console.error('Usage: set-engagement-start.ts YYYY-MM [--dry-run] [--replace]');
  process.exit(1);
}

class Rollback extends Error {}

const { db, close } = getOwnerDb();

try {
  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const where = and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, KEY));
    const [before] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
    const current = (before?.value as { month?: unknown } | undefined)?.month ?? null;

    if (typeof current === 'string' && current !== month && !REPLACE) {
      throw new Error(
        `Refusing to move ${slug}'s start month from ${current} to ${month}: every ramp ` +
          'actual is aligned to it. Pass --replace if the recorded month is wrong.',
      );
    }

    const description =
      spartan.config.find((c) => c.key === KEY)?.description ?? 'The calendar month M1 of the ramp lands on.';
    await tx
      .insert(schema.tenantConfig)
      .values({ tenantId: tenant.id, key: KEY, value: { month }, description })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: { month }, updatedAt: new Date() },
      });

    const [after] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
    if ((after?.value as { month?: unknown } | undefined)?.month !== month) {
      throw new Error(
        'Refusing to commit: the row did not read back as written. A write that matched ' +
          'nothing is the signature of row level security denying it — check that this role ' +
          'is a member of zeeraa_maintenance.',
      );
    }

    const result = { tenant: `${tenant.name} (${slug})`, before: current, after: month };
    if (DRY_RUN) throw new Rollback();
    return result;
  }).catch((error) => {
    if (error instanceof Rollback) return null;
    throw error;
  });

  if (summary === null) {
    console.log(`Dry run against ${slug}: M1 = ${month} lands and was rolled back. Nothing changed.`);
  } else {
    console.log(`Engagement start for ${summary.tenant}: ${summary.before ?? '(not set)'} → ${summary.after}`);
  }
} finally {
  await close();
}
