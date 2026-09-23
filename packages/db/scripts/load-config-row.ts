/**
 * Loads one tenant_config row from the seed, by key, and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-config-row.ts <key> --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-config-row.ts <key>
 *
 * The general form of `load-lead-response-hours.ts`, for the next config row
 * a hosted database needs: `db:seed` would rewrite every row, including
 * `engagement_start_month`, and one row should not carry that blast radius.
 *
 *   * `--dry-run` writes inside a transaction, reads it back and rolls back —
 *     under FORCE a denied write matches nothing and exits 0.
 *   * A row that already differs from the seed is not overwritten without
 *     `--replace`: once somebody edits it in production, the seed is the stale
 *     copy.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const key = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
if (!key || key.startsWith('--')) throw new Error('Usage: load-config-row.ts <key> [--dry-run] [--replace]');

const entry = spartan.config.find((c) => c.key === key);
if (!entry) throw new Error(`The seed carries no ${key} row.`);

class Rollback extends Error {}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const { db, close } = getOwnerDb();
try {
  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const where = and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, key));
    const [before] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
    const wanted = canonical(entry.value);
    if (before && canonical(before.value) !== wanted && !REPLACE) {
      throw new Error(
        `Refusing to overwrite ${key}: it differs from the seed.\n  current: ${canonical(before.value)}\n  seed:    ${wanted}\n` +
          'Pass --replace if the seed is the one to keep.',
      );
    }
    await tx
      .insert(schema.tenantConfig)
      .values({ tenantId: tenant.id, key, value: entry.value, description: entry.description ?? null })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: entry.value, description: entry.description ?? null, updatedAt: new Date() },
      });
    const [after] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
    if (!after || canonical(after.value) !== wanted) {
      throw new Error('Refusing to commit: the row did not read back as written — row level security denied it.');
    }
    const result = { before: before ? canonical(before.value) : '(none)', after: canonical(after.value) };
    if (DRY_RUN) throw new Rollback();
    return result;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (summary === null) console.log(`Dry run against ${slug}: ${key} lands and was rolled back. Nothing changed.`);
  else console.log(`Loaded ${key} for ${slug}\n  before: ${summary.before}\n  after:  ${summary.after}`);
} finally {
  await close();
}
