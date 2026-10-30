/**
 * Writes the calls Aloware's own webhook delivered in shadow into `calls`.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… \
 *     npx tsx scripts/promote-shadow-calls.ts <slug> [--since <ISO instant>] [--dry-run]
 *
 * For a sender switched to `live` after the Zap had already stopped (30
 * October 2026): the Zap's last call landed on 22 October, and every call
 * after it was recorded only as Aloware's shadow copy in `call_deliveries`.
 * Each copy not yet in `calls` is upserted through the webhook's own writer,
 * on the Communication ID, so a call already stored is left as it is and a
 * re-run changes nothing. The outcome and the brief-answer flag are re-derived
 * from the copy's disposition and talk time with the tenant's mapping, as the
 * webhook would have; the raw number is the stored ten-digit key, and the
 * Aloware contact id, which a copy does not keep, is left empty. Then the
 * copies are marked written and the new calls matched to leads.
 *
 * `--dry-run` writes, counts what landed and rolls back: under FORCE a denied
 * write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { classifyDisposition, DEFAULT_ALOWARE_MAPPING, type AlowareMapping, type CallRow } from '@zeeraa/connectors';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { resolveCallLeads, upsertCallsCounted } from '../src/aloware/writer';

const args = process.argv.slice(2);
const slug = args[0];
const DRY_RUN = args.includes('--dry-run');
const sinceAt = args.indexOf('--since');
const since = sinceAt === -1 ? null : new Date(args[sinceAt + 1] ?? '');
if (!slug || slug.startsWith('--') || (since && Number.isNaN(since.getTime()))) {
  throw new Error('Usage: promote-shadow-calls.ts <slug> [--since <ISO instant>] [--dry-run]');
}

class Rollback extends Error {}

const tenant = await withMaintenance(getMaintenanceDb(), async (tx) => {
  const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!t) throw new Error(`No tenant with slug "${slug}".`);
  const [config] = await tx
    .select({ value: schema.tenantConfig.value })
    .from(schema.tenantConfig)
    .where(and(eq(schema.tenantConfig.tenantId, t.id), eq(schema.tenantConfig.key, 'aloware')));
  const mapping = { ...DEFAULT_ALOWARE_MAPPING, ...((config?.value as Partial<AlowareMapping>) ?? {}) } as AlowareMapping;
  return { id: t.id, mapping };
});

const result = await withJobTenant(tenant.id, async (tx) => {
  const d = schema.callDeliveries;
  const copies = await tx.execute<{
    external_id: string;
    occurred_at: string;
    direction: string;
    disposition: string | null;
    talk: string | null;
    duration: string | null;
    contact_key: string | null;
    agent_name: string | null;
    agent_external_id: string | null;
  }>(sql`
    select ${d.externalId} as external_id, ${d.occurredAt}::text as occurred_at, ${d.direction} as direction,
      ${d.disposition} as disposition, ${d.talkTimeSeconds}::text as talk, ${d.durationSeconds}::text as duration,
      ${d.contactKey} as contact_key, ${d.agentName} as agent_name, ${d.agentExternalId} as agent_external_id
    from ${d}
    where ${d.tenantId} = ${tenant.id} and ${d.sender} = 'aloware'
      ${since ? sql`and ${d.occurredAt} >= ${since.toISOString()}` : sql``}
      and not exists (
        select 1 from ${schema.calls} c where c.tenant_id = ${d.tenantId} and c.external_id = ${d.externalId}
      )
    order by ${d.occurredAt}`);

  const rows: CallRow[] = [...copies].map((c) => {
    const talk = c.talk === null ? null : Number(c.talk);
    const { outcome, answeredBriefly } = classifyDisposition(c.disposition, tenant.mapping, talk);
    return {
      externalId: c.external_id,
      occurredAt: new Date(c.occurred_at),
      direction: (['inbound', 'outbound'].includes(c.direction) ? c.direction : 'unknown') as CallRow['direction'],
      outcome,
      disposition: c.disposition,
      talkTimeSeconds: talk,
      durationSeconds: c.duration === null ? null : Number(c.duration),
      contactNumber: c.contact_key,
      contactKey: c.contact_key,
      contactExternalId: null,
      agentName: c.agent_name ?? (c.agent_external_id ? (tenant.mapping.agents?.[c.agent_external_id] ?? null) : null),
      agentExternalId: c.agent_external_id,
      answeredBriefly,
    } as CallRow;
  });

  const { inserted } = await upsertCallsCounted(tx, tenant.id, rows, 'webhook', null);
  await tx.execute(sql`
    update ${d} set written = true
    where ${d.tenantId} = ${tenant.id} and ${d.sender} = 'aloware'
      and exists (select 1 from ${schema.calls} c where c.tenant_id = ${d.tenantId} and c.external_id = ${d.externalId})
      and not ${d.written}`);
  const leads = await resolveCallLeads(tx, tenant.id);
  const [range] = await tx.execute<{ first: string | null; last: string | null; n: number }>(sql`
    select min(occurred_at)::text first, max(occurred_at)::text last, count(*)::int n
    from ${schema.calls} where tenant_id = ${tenant.id} and occurred_at > '2026-10-22T15:28:25Z'`);
  console.log(
    `Shadow copies not in calls: ${rows.length}; inserted: ${inserted}. ` +
      `Calls after the Zap's last now: ${range?.n ?? 0} (${range?.first ?? '—'} to ${range?.last ?? '—'}).`,
  );
  console.log('Lead match:', JSON.stringify(leads));
  if (DRY_RUN) throw new Rollback();
  return inserted;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(result === null ? 'Dry run: rolled back. Nothing changed.' : `Promoted ${result} calls.`);
process.exit(0);
