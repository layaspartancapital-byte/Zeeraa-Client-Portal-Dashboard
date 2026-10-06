/**
 * Sets how a tenant's Aloware webhook senders are treated, and nothing else.
 *
 *   pnpm --filter @zeeraa/db configure-aloware <tenant-slug> \
 *     [--direct-mode shadow|live] [--agent 123260="Agent Name" ...] [--dry-run]
 *
 * Touches one row, `tenant_config` key `aloware`, merging: keys not named keep
 * their value, so recording an agent does not restate the threshold.
 *
 *   --direct-mode live    Aloware's own webhook writes calls. Run it only once
 *                         `aloware-senders` says its copies match the Zap's.
 *   --direct-mode shadow  Back to comparing only. The Zap is unaffected.
 *   --agent id=name       The native post carries the agent's id and no name.
 *
 * `--dry-run` writes inside a transaction, reads the row back and rolls back:
 * `tenant_config` is FORCE RLS'd, so a write by a role holding no policy
 * matches nothing and exits 0. Refuses before migration 0043, because a direct
 * post in live mode with no `call_deliveries` to record into fails every time.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const args = process.argv.slice(2);
const slug = args[0];
const DRY_RUN = args.includes('--dry-run');
if (!slug || slug.startsWith('--')) {
  throw new Error('Usage: configure-aloware <tenant-slug> [--direct-mode shadow|live] [--agent id=name ...] [--dry-run]');
}

const modeAt = args.indexOf('--direct-mode');
const mode = modeAt === -1 ? undefined : args[modeAt + 1];
if (mode !== undefined && mode !== 'shadow' && mode !== 'live') {
  throw new Error(`--direct-mode must be shadow or live; got "${mode}".`);
}
const agents: Record<string, string> = {};
args.forEach((arg, i) => {
  if (arg !== '--agent') return;
  const match = /^(\d+)=(.+)$/.exec(args[i + 1] ?? '');
  if (!match) throw new Error(`--agent must be <numeric id>=<name>; got "${args[i + 1] ?? ''}".`);
  agents[match[1]!] = match[2]!.trim();
});
if (mode === undefined && Object.keys(agents).length === 0) {
  throw new Error('Nothing to set: pass --direct-mode and/or --agent.');
}

class Rollback extends Error {}
const { db, close } = getOwnerDb();

try {
  const [table] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('public.call_deliveries') is not null as exists`,
  );
  if (!table?.exists) throw new Error('Refusing: migration 0043 (call_deliveries) has not been applied here.');

  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const where = and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'aloware'));
    const [existing] = await tx.select().from(schema.tenantConfig).where(where);
    const previous = (existing?.value ?? {}) as Record<string, unknown>;
    const value = {
      ...previous,
      ...(mode ? { directMode: mode } : {}),
      ...(Object.keys(agents).length
        ? { agents: { ...((previous.agents as Record<string, string>) ?? {}), ...agents } }
        : {}),
    };

    if (existing) {
      await tx.update(schema.tenantConfig).set({ value, updatedAt: new Date() }).where(where);
    } else {
      await tx.insert(schema.tenantConfig).values({
        tenantId: tenant.id,
        key: 'aloware',
        value,
        description:
          'Aloware call ingestion: talk-time threshold, whether Aloware’s own webhook writes calls ' +
          '(directMode) or is only compared with the Zap’s copies, and agent names by Aloware user id.',
      });
    }

    const [after] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
    if (!after || JSON.stringify(after.value) !== JSON.stringify(value)) {
      throw new Error(
        'Refusing to commit: the config row does not read back as written. Under FORCE row ' +
          'level security that is a denied write — check this role is in zeeraa_maintenance.',
      );
    }
    const result = { tenant: `${tenant.name} (${slug})`, before: previous, after: after.value };
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
