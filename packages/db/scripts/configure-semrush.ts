/**
 * Records a tenant's Semrush project on its `semrush` connection, and nothing
 * else.
 *
 *   pnpm --filter @zeeraa/db configure-semrush <tenant-slug> --project 29644497 \
 *     --domain spartancapitalgroup.com [--database us] \
 *     [--campaign 29644497_123456 --tracked-keywords 80 --tracking-url '*.spartancapitalgroup.com/*']
 *     [--annual-budget 650000] [--dry-run]
 *
 * Touches one row. `--campaign` may be given on its own later: fields not
 * named keep their value, so recording the Position Tracking campaign does not
 * need the project restated.
 *
 * `--dry-run` writes inside a transaction, reads the row back and rolls back.
 * `connections` is FORCE RLS'd, so a write by a role holding no policy
 * matches nothing and exits 0; the read-back is what says it landed. Refuses
 * before migration 0042, because a connection that is configured and has
 * nowhere to write is a nightly failure.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const args = process.argv.slice(2);
const slug = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const DRY_RUN = args.includes('--dry-run');
if (!slug || slug.startsWith('--')) {
  throw new Error('Usage: configure-semrush <tenant-slug> --project <id> --domain <domain> [--campaign <id> --tracking-url <mask>] [--dry-run]');
}

class Rollback extends Error {}
const { db, close } = getOwnerDb();

try {
  const [table] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('public.seo_report_reads') is not null as exists`,
  );
  if (!table?.exists) throw new Error('Refusing: migration 0042 (seo_*) has not been applied here.');

  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [existing] = await tx
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'semrush')));
    const previous = (existing?.config ?? {}) as Record<string, unknown>;

    const project = flag('project') ?? (previous.projectId ? String(previous.projectId) : undefined);
    if (!project || !/^\d+$/.test(project)) throw new Error('--project <numeric id> is required the first time.');
    const domain = (flag('domain') ?? (previous.domain as string | undefined))?.replace(/^www\./, '');
    if (!domain) throw new Error('--domain is required the first time.');
    const campaign = flag('campaign') ?? (previous.trackingCampaignId as string | undefined) ?? null;
    if (campaign && !/^\d+_\d+$/.test(campaign)) {
      throw new Error(`--campaign should look like {projectId}_{n}; got "${campaign}".`);
    }
    const numeric = (name: string, fallback: unknown) => {
      const value = flag(name);
      if (value === undefined) return typeof fallback === 'number' ? fallback : undefined;
      if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number; got "${value}".`);
      return Number(value);
    };
    const config = {
      ...previous,
      trackedKeywords: numeric('tracked-keywords', previous.trackedKeywords),
      annualUnitBudget: numeric('annual-budget', previous.annualUnitBudget),
      projectId: Number(project),
      domain,
      database: flag('database') ?? (previous.database as string | undefined) ?? 'us',
      trackingCampaignId: campaign,
      trackingUrl: flag('tracking-url') ?? (previous.trackingUrl as string | undefined) ?? `*.${domain}/*`,
    };

    if (existing) {
      await tx
        .update(schema.connections)
        .set({ config, accountIdentifier: project, status: 'healthy' })
        .where(eq(schema.connections.id, existing.id));
    } else {
      await tx.insert(schema.connections).values({
        tenantId: tenant.id,
        platform: 'semrush',
        accountIdentifier: project,
        config,
        status: 'healthy',
      });
    }

    const [after] = await tx
      .select({ config: schema.connections.config, status: schema.connections.status })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'semrush')));
    if (!after || (after.config as { projectId?: number }).projectId !== Number(project)) {
      throw new Error(
        'Refusing to commit: the connection row does not read back as written. Under FORCE ' +
          'row level security that is a denied write — check this role is in zeeraa_maintenance.',
      );
    }
    const result = { tenant: `${tenant.name} (${slug})`, status: after.status, config: after.config };
    if (DRY_RUN) {
      console.log('Would write:', JSON.stringify(result, null, 2));
      throw new Rollback();
    }
    return result;
  }).catch((error) => {
    if (error instanceof Rollback) return null;
    throw error;
  });

  if (summary === null) console.log(`Dry run against ${slug}: the write lands and was rolled back.`);
  else console.log('Configured:', JSON.stringify(summary, null, 2));
} finally {
  await close();
}
