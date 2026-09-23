/**
 * Loads one tenant's `lead_response_hours` config row, and nothing else.
 *
 * `db:seed` would also do this, and against a hosted database it would rewrite
 * every other `tenant_config` row from the seed constant as well — including
 * `engagement_start_month`. One row should not carry that blast radius.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-lead-response-hours.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-lead-response-hours.ts
 *
 * Two safeguards:
 *
 *   * **`--dry-run` writes inside a transaction and rolls it back.** Every
 *     tenant-scoped table is FORCE RLS'd, so a write by a role holding no
 *     policy matches nothing, raises nothing and exits 0. The read-back inside
 *     the transaction is what proves the write landed.
 *   * **It will not overwrite a row that already differs from the seed**
 *     without `--replace`. Once somebody records a holiday in production, the
 *     seed's empty list is the stale copy, and re-running this should not
 *     quietly delete the holiday.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const KEY = 'lead_response_hours';

class Rollback extends Error {}

/**
 * JSON with its keys sorted. `jsonb` stores an object's keys in its own order,
 * so the row never reads back in the order the seed wrote it and a plain
 * `JSON.stringify` comparison would call every write a failure.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const entry = spartan.config.find((c) => c.key === KEY);
if (!entry) throw new Error(`The seed carries no ${KEY} row.`);

const { db, close } = getOwnerDb();

try {
  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const where = and(
      eq(schema.tenantConfig.tenantId, tenant.id),
      eq(schema.tenantConfig.key, KEY),
    );
    const [before] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(where);

    const wanted = canonical(entry.value);
    if (before && canonical(before.value) !== wanted && !REPLACE) {
      throw new Error(
        `Refusing to overwrite: ${slug} already has a ${KEY} row that differs from the seed.\n` +
          `  current: ${canonical(before.value)}\n` +
          `  seed:    ${wanted}\n` +
          'Pass --replace if the seed is the one to keep.',
      );
    }

    await tx
      .insert(schema.tenantConfig)
      .values({
        tenantId: tenant.id,
        key: KEY,
        value: entry.value,
        description: entry.description ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: entry.value, description: entry.description ?? null, updatedAt: new Date() },
      });

    // Read back inside the transaction: under FORCE a denied write leaves the
    // table as it was and says nothing.
    const [after] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(where);
    if (!after || canonical(after.value) !== wanted) {
      throw new Error(
        'Refusing to commit: the row did not read back as written. A write that ' +
          'matched nothing is the signature of row level security denying it — ' +
          'check that this role is a member of zeeraa_maintenance.',
      );
    }

    const result = {
      tenant: `${tenant.name} (${slug})`,
      before: before ? canonical(before.value) : '(none)',
      after: canonical(after.value),
    };
    if (DRY_RUN) throw new Rollback();
    return result;
  }).catch((error) => {
    if (error instanceof Rollback) return null;
    throw error;
  });

  if (summary === null) {
    console.log(`Dry run against ${slug}: the ${KEY} write lands and was rolled back. Nothing changed.`);
  } else {
    console.log(`Loaded ${KEY} for ${summary.tenant}`);
    console.log(`  before: ${summary.before}`);
    console.log(`  after:  ${summary.after}`);
  }
} finally {
  await close();
}
