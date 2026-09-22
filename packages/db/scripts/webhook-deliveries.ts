/**
 * What has reached the webhook endpoints, and what became of it.
 *
 * The question this answers is the one the database could not: has a pushed
 * source ever called us, and if it has, why is nothing landing. A pushed source
 * has no sync run to fail, so before `webhook_deliveries` existed the three
 * cases below were one empty table.
 *
 *   no rows at all         nobody has ever posted — subscription, or the URL
 *   received > 0, accepted 0   posting and being refused; `reasons` says why
 *   accepted > 0           working
 *
 * Read-only. Safe against production, and that is where it is useful:
 *
 *   ( set -a; . ./.env.neon; set +a
 *     DATABASE_URL_MAINT="$DATABASE_URL_MAINT" \
 *       pnpm --filter @zeeraa/db exec tsx scripts/webhook-deliveries.ts )
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL_MAINT;
if (!url) {
  console.error('DATABASE_URL_MAINT is not set. Source .env for local, .env.neon for production.');
  process.exit(1);
}

const days = Number(process.argv[2] ?? 30);
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main(): Promise<void> {
  await sql.begin(async (tx) => {
    // The maintenance role, because "has any tenant's endpoint been reached"
    // is a question that cannot be asked from inside one tenant.
    await tx`select set_config('app.maintenance', 'on', true)`;

    const rows = await tx`
      select t.slug, d.source, d.day, d.received, d.accepted, d.rejected,
             d.last_received_at, d.reasons
      from webhook_deliveries d
      join tenants t on t.id = d.tenant_id
      where d.day >= current_date - ${days}::int
      order by d.day desc, t.slug, d.source`;

    if (rows.length === 0) {
      console.log(
        `No webhook delivery in the last ${days} days.\n` +
          'Nothing has posted to any endpoint — check the vendor subscription and\n' +
          'the URL before looking any further at the reader.',
      );
      return;
    }

    console.table(
      rows.map((r) => ({
        tenant: r.slug,
        source: r.source,
        day: r.day,
        received: r.received,
        accepted: r.accepted,
        rejected: r.rejected,
        last: r.last_received_at,
      })),
    );

    // The reasons are the actionable half and do not fit a table column.
    for (const row of rows) {
      const reasons = Object.entries(row.reasons as Record<string, number>);
      if (reasons.length === 0) continue;
      console.log(`\n${row.slug}/${row.source} ${row.day}:`);
      for (const [reason, count] of reasons.sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(6)}  ${reason}`);
      }
    }

    const silent = await tx`
      select t.slug, d.source, max(d.day) as last_day, sum(d.accepted)::int as accepted
      from webhook_deliveries d join tenants t on t.id = d.tenant_id
      group by t.slug, d.source having sum(d.accepted) = 0`;
    for (const row of silent) {
      console.log(
        `\n${row.slug}/${row.source}: posts are arriving and NOTHING has ever been ` +
          `accepted (last ${row.last_day}). That is a reader problem, not a vendor one.`,
      );
    }
  });
  await sql.end();
}

main();
