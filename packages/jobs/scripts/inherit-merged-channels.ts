/**
 * Applies `inheritMergedChannels` once, for a tenant, now — the pass every
 * Salesforce sync runs from this change on. Touches `leads.channel` on merge
 * survivors that have none, and nothing else.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… \
 *     npx tsx scripts/inherit-merged-channels.ts <slug> --dry-run
 *
 * Run before the deploy that adds the pass, because the deploy's number check
 * reads the data as it stands and the first sync has not run yet.
 *
 * `--dry-run` writes, reads back the survivors still without an inheritable
 * channel and rolls back: under FORCE a denied write matches nothing and exits
 * 0, so the read-back is what says it landed.
 */
import { eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { inheritMergedChannels } from '../src/salesforce/writer';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: inherit-merged-channels.ts <slug> [--dry-run]');

class Rollback extends Error {}

const tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
  const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!t) throw new Error(`No tenant with slug "${slug}".`);
  return t.id;
});

const pending = sql`
  select count(*)::int as n from leads s
  where s.tenant_id = ${tenantId} and s.channel is null and s.click_id_type is null
    and exists (select 1 from leads l where l.tenant_id = s.tenant_id and l.merged_into = s.external_id
                and coalesce(l.channel, l.click_id_type) is not null)`;

const result = await withJobTenant(tenantId, async (tx) => {
  const [before] = await tx.execute<{ n: number }>(pending);
  const changed = await inheritMergedChannels(tx, tenantId);
  const [after] = await tx.execute<{ n: number }>(pending);
  const byMonth = await tx.execute<{ m: string; ch: string; n: number }>(sql`
    select to_char(s.created_on, 'YYYY-MM') m, s.channel ch, count(*)::int n from leads s
    where s.tenant_id = ${tenantId} and s.excluded_reason is null and s.channel is not null
      and exists (select 1 from leads l where l.tenant_id = s.tenant_id and l.merged_into = s.external_id)
      and s.updated_at is not null
    group by 1, 2 order by 1, 2`);
  console.log(`Survivors waiting for a channel: ${before!.n}; given one: ${changed}; still waiting: ${after!.n}`);
  if (after!.n !== 0) throw new Error('Refusing to commit: survivors still lack an inheritable channel — a denied write?');
  if (DRY_RUN) {
    console.log('Counted survivors with a channel, by month (after):', [...byMonth].map((r) => `${r.m} ${r.ch}=${r.n}`).join(', '));
    throw new Rollback();
  }
  return changed;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(result === null ? 'Dry run: the write lands and was rolled back.' : `Gave ${result} survivors their merged lead's channel.`);
process.exit(0);
