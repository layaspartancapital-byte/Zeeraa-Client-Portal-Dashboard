/**
 * Imports an Aloware call export.
 *
 *   pnpm --filter @zeeraa/jobs import-aloware-calls <tenant-slug> <file.csv> [--dry-run]
 *
 * Historical backfill only. Everything after the export's last call arrives
 * through the webhook at `/api/webhooks/aloware/{tenant}`, and both routes
 * upsert on Aloware's Communication ID — so re-running this over an overlapping
 * export cannot double-count, and neither can a webhook re-delivery.
 *
 * **The file is PII.** It holds merchants' phone numbers, names, emails, call
 * recordings and note bodies. Only the columns this platform needs are read:
 * the id, the timestamp, type, direction, disposition, the two durations, the
 * contact number and id, and the agent's name. Names, emails, bodies, notes and
 * recording links are not read and are not stored. Nothing printed by this
 * script identifies anybody — the summary is counts, reasons and a date range.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_ALOWARE_MAPPING,
  normalizeCalls,
  parseCsv,
  type AlowareMapping,
} from '@zeeraa/connectors';
import { getOwnerDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { formatDuration } from '@zeeraa/core';
import { upsertCalls, resolveCallLeads } from '../src/aloware/writer';
import { closeSyncRun, openSyncRun, recordSourceWindow } from '../src/sync-runs';

const args = process.argv.slice(2);
const slug = args[0];
const path = args[1];
const dryRun = args.includes('--dry-run');

if (!slug || !path) {
  throw new Error(
    'Usage: tsx scripts/import-aloware-calls.ts <tenant-slug> <file.csv> [--dry-run]',
  );
}

const { db, close } = getOwnerDb();

try {
  const { tenantId, timezone, mapping } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({
        id: schema.tenants.id,
        name: schema.tenants.name,
        timezone: schema.tenants.timezone,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    // The column names and the disposition vocabulary are configuration, so a
    // changed export is a config edit rather than a code change.
    const [row] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'aloware')),
      );

    console.log(`${tenant.name} — Aloware call import`);
    return {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      mapping: {
        ...DEFAULT_ALOWARE_MAPPING,
        ...((row?.value as Partial<AlowareMapping>) ?? {}),
      } as AlowareMapping,
    };
  });

  const records = parseCsv(readFileSync(path, 'utf8'));
  /*
   * Timezone matters here more than anywhere else in this codebase.
   *
   * The export writes `2026-06-19 11:32:04` with no offset. Read as UTC, every
   * call lands four or five hours before it happened — and speed to lead is a
   * subtraction between a CRM timestamp and a call timestamp, so the error
   * would not look like an error. It would look like a desk that never picks
   * up the phone.
   */
  const result = normalizeCalls(records, timezone, mapping);

  console.log(`\n  ── parsed ──`);
  console.log(`  rows in file:              ${records.length}`);
  console.log(`  calls:                     ${result.rows.length}`);
  for (const [type, n] of Object.entries(result.skippedByType)) {
    console.log(`  skipped, not a call:       ${n} (${type})`);
  }
  for (const [reason, n] of Object.entries(result.dropped)) {
    console.log(`  DROPPED:                   ${n} (${reason})`);
  }
  console.log(
    `  window:                    ${result.span.earliest?.toISOString().slice(0, 10) ?? '(none)'}` +
      ` .. ${result.span.latest?.toISOString().slice(0, 10) ?? '(none)'}`,
  );

  const { connected, attempted, abandoned } = result.counts;
  console.log(`\n  ── outcomes ──`);
  console.log(`  connected:                 ${connected}  (talk time >= ${formatDuration(mapping.connectedMinTalkSeconds)})`);
  console.log(`  attempted:                 ${attempted}`);
  console.log(`    of which answered, brief: ${result.answeredBriefly}`);
  console.log(`  abandoned (excluded):      ${abandoned}`);
  if (Object.keys(result.unclassified).length > 0) {
    console.log('  UNCLASSIFIED dispositions (counted as attempted; add to the mapping):');
    for (const [v, n] of Object.entries(result.unclassified)) console.log(`    ${v}: ${n}`);
  }
  if (Object.keys(result.unkeyedNumbers).length > 0) {
    console.log('  numbers that cannot be joined, by reason:');
    for (const [why, n] of Object.entries(result.unkeyedNumbers)) console.log(`    ${why}: ${n}`);
  }

  if (dryRun) {
    console.log('\n  --dry-run: nothing written.');
  } else {
    const written = await withJobTenant(tenantId, async (tx) => {
      const syncRunId = await openSyncRun(tx, tenantId, 'import', new Date(), 'aloware');
      const n = await upsertCalls(tx, tenantId, result.rows, 'csv_import', syncRunId);
      if (result.span.earliest) {
        await recordSourceWindow(
          tx,
          tenantId,
          'aloware:calls',
          'aloware',
          result.span.earliest,
          syncRunId,
        );
      }
      await closeSyncRun(tx, syncRunId, 'succeeded', n, null);
      return n;
    });
    console.log(`\n  ── written ──`);
    console.log(`  calls upserted:            ${written}`);

    // Its own pass, and idempotent: a call can arrive before its lead exists.
    const match = await withJobTenant(tenantId, (tx) => resolveCallLeads(tx, tenantId));
    console.log(`\n  ── lead join (by phone number) ──`);
    console.log(`  calls newly matched:       ${match.matched}`);
    console.log(`  unmatched (keyed number):  ${match.unmatched}`);
    console.log(`  unjoinable number:         ${match.unkeyed}`);
    console.log(
      `  ambiguous keys:            ${match.ambiguousKeys} (${match.ambiguousCalls} calls left unmatched)`,
    );
  }
} finally {
  await close();
}
