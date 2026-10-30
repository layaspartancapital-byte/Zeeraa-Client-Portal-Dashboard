import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import { monthRange, type MonthKey } from '@zeeraa/core';
import { affectedRows } from './affected-rows';
import { stageMetric, UNATTRIBUTED } from './channel-figures';

/**
 * Which leads a frozen month's lead counts were made of, and what moved them
 * since (migration 0047, 30 October 2026).
 *
 * A frozen lead or MQL count is a total, and Spartan merges duplicate leads in
 * Salesforce weeks after a month is frozen. Each merge moves a count, and a
 * total cannot say whether the record moved it or the code did. So whenever a
 * month's channel figures are frozen or corrected, every lead created in it is
 * recorded: the outcome (channel, counted, qualified) and the evidence — the
 * Salesforce fields a merge or a source edit changes.
 *
 * A lead that has since entered or left a frozen figure is **proven** when its
 * Salesforce fields changed: deleted, merged away, merged into, its creation
 * date moved, its Lead Source or its click and UTM fields edited. A lead that
 * moved with every Salesforce field as recorded was moved by the code, and is
 * not proven. Only a figure every move of which is proven may be restated
 * without a person — the deploy's number check lets it pass, and the daily
 * job freezes it as the next version (`autoCorrectLeadFigures`).
 *
 * Deal stages, spend and the ramp are not traced here: a lead merge does not
 * move them, and a difference in them still needs a person.
 *
 * The derived columns — `channel`, `mql_verdict`, `revenue_band`,
 * `excluded_reason` — are outcomes, never evidence: a rule change that moves
 * them must read as the code.
 */

/** The fields hashed into `fields_hash`, as stored from Salesforce. */
const HASHED = [
  'click_id',
  'click_id_type',
  'braid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'landing_page',
  'capture_url',
  'referrer_url',
  'self_reported_revenue',
  'self_reported_annual_revenue',
  'converted_opportunity_id',
] as const;

/** The evidence columns for a `leads` row under `alias`. */
function evidence(alias: string) {
  const a = sql.raw(alias);
  const hashed = sql.raw(HASHED.map((c) => `coalesce(${alias}.${c}::text, '∅')`).join(', '));
  return {
    createdAt: sql`${a}.created_at`,
    mergedInto: sql`${a}.merged_into`,
    mergedFrom: sql`(select string_agg(m.external_id, ',' order by m.external_id) from ${schema.leads} m
                     where m.tenant_id = ${a}.tenant_id and m.merged_into = ${a}.external_id)`,
    leadSource: sql`${a}.lead_source`,
    fieldsHash: sql`md5(concat_ws('|', ${hashed}))`,
  };
}

/** The lead stages: counted from leads, not from stage events. */
export async function leadStages(tx: Database, tenantId: string): Promise<{ key: string; qualifiedOnly: boolean }[]> {
  const rows = await tx
    .select({ key: schema.funnelStages.key, source: schema.funnelStages.source })
    .from(schema.funnelStages)
    .where(and(eq(schema.funnelStages.tenantId, tenantId), inArray(schema.funnelStages.source, ['leads', 'qualified_leads'])))
    .orderBy(asc(schema.funnelStages.position));
  return rows.map((r) => ({ key: r.key, qualifiedOnly: r.source === 'qualified_leads' }));
}

/**
 * Records every lead created in `month` as it stands now. Run inside the
 * transaction that freezes or corrects the month's channel figures, after it,
 * so the recording is of exactly what was frozen. Refuses — and so rolls the
 * freeze back — when the recording does not reproduce a frozen lead count:
 * a ledger that disagrees with its figure would prove nothing.
 */
export async function recordBaselineLeads(
  tx: Database,
  tenantId: string,
  month: MonthKey,
  options: { by: string; reason: string; now: Date },
): Promise<number> {
  const { start, end } = monthRange(month);
  const l = evidence('l');
  const written = affectedRows(
    await tx.execute(sql`
      insert into ${schema.baselineLeads}
        (tenant_id, month, recorded_at, external_id, created_on, channel, counted, qualified,
         created_at, merged_into, merged_from, lead_source, fields_hash, recorded_by, reason)
      select l.tenant_id, ${start}::date, ${options.now.toISOString()}::timestamptz, l.external_id, l.created_on,
             coalesce(l.channel, l.click_id_type), l.excluded_reason is null, coalesce(l.mql_verdict = 'qualified', false),
             ${l.createdAt}, ${l.mergedInto}, ${l.mergedFrom}, ${l.leadSource}, ${l.fieldsHash},
             ${options.by}, ${options.reason}
      from ${schema.leads} l
      where l.tenant_id = ${tenantId} and l.created_on between ${start} and ${end}`),
  );
  const proofs = await leadFigureProofs(tx, tenantId, month);
  const wrong = [...proofs.values()].filter((p) => p.frozen !== null && p.recorded !== p.frozen);
  if (wrong.length > 0) {
    throw new Error(
      `The ${month} lead recording does not reproduce the frozen figures: ${wrong
        .map((p) => `${p.platform} ${p.metric} frozen ${p.frozen}, recorded ${p.recorded}`)
        .join('; ')}. Correct the figures first.`,
    );
  }
  return written;
}

export type LeadMove = {
  externalId: string;
  change: 'entered' | 'left';
  proven: boolean;
  /** What Salesforce changed, or why nothing proves it did. */
  why: string;
};

export type LeadFigureProof = {
  platform: string;
  metric: string;
  /** The latest frozen value, or null where the figure is retired or blank. */
  frozen: number | null;
  /** The count the month's recording holds; null when it has none. */
  recorded: number | null;
  /** The count now. */
  now: number;
  moves: LeadMove[];
};

type MovedRow = {
  external_id: string;
  rec_channel: string | null;
  rec_counted: boolean;
  rec_qualified: boolean;
  in_month: boolean;
  now_channel: string | null;
  now_counted: boolean;
  now_qualified: boolean;
  prior: boolean;
  created_moved: boolean;
  prior_merged_into: string | null;
  prior_merged_from: string | null;
  prior_lead_source: string | null;
  prior_fields_hash: string | null;
  current: boolean;
  cur_created_on: string | null;
  cur_merged_into: string | null;
  cur_merged_from: string | null;
  cur_lead_source: string | null;
  cur_fields_hash: string | null;
};

/**
 * For each frozen lead-stage figure of `month`: the recorded count, the count
 * now, and every lead that moved in or out of it, each with whether Salesforce
 * proves the move. Keyed `platform|metric`, as the frozen rows are. Empty when
 * the month has no lead figures frozen. Reads counts and the moved leads only.
 */
export async function leadFigureProofs(tx: Database, tenantId: string, month: MonthKey): Promise<Map<string, LeadFigureProof>> {
  const stages = await leadStages(tx, tenantId);
  const out = new Map<string, LeadFigureProof>();
  if (stages.length === 0) return out;
  const metrics = stages.map((s) => stageMetric(s.key));
  const { start, end } = monthRange(month);

  const frozen = await tx.execute<{ platform: string; metric: string; value: string | null }>(sql`
    select distinct on (platform, metric) platform, metric, value
    from ${schema.baselineSnapshots}
    where tenant_id = ${tenantId} and month = ${start}::date
      and metric in (${sql.join(metrics.map((m) => sql`${m}`), sql`, `)})
    order by platform, metric, version desc`);
  if (frozen.length === 0) return out;

  const recording = sql`(
    select b.* from ${schema.baselineLeads} b
    where b.tenant_id = ${tenantId} and b.month = ${start}::date
      and b.recorded_at = (select max(recorded_at) from ${schema.baselineLeads}
                           where tenant_id = ${tenantId} and month = ${start}::date))`;
  const inMonth = sql`(
    select l.external_id, coalesce(l.channel, l.click_id_type) as channel,
           l.excluded_reason is null as counted, coalesce(l.mql_verdict = 'qualified', false) as qualified
    from ${schema.leads} l
    where l.tenant_id = ${tenantId} and l.created_on between ${start} and ${end})`;

  const [hasRecording] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${recording} r`);
  const counts = async (from: SQL) =>
    tx.execute<{ channel: string | null; qualified: boolean; n: number }>(sql`
      select channel, qualified, count(*)::int as n from ${from} x where counted group by channel, qualified`);
  const recordedCounts = Number(hasRecording?.n ?? 0) > 0 ? await counts(recording) : null;
  const nowCounts = await counts(inMonth);

  const cur = evidence('c');
  const moved = Number(hasRecording?.n ?? 0) === 0 ? [] : await tx.execute<MovedRow>(sql`
    select coalesce(n.external_id, r.external_id) as external_id,
           r.channel as rec_channel, coalesce(r.counted, false) as rec_counted, coalesce(r.qualified, false) as rec_qualified,
           n.external_id is not null as in_month, n.channel as now_channel,
           coalesce(n.counted, false) as now_counted, coalesce(n.qualified, false) as now_qualified,
           p.external_id is not null as prior,
           p.created_at is distinct from c.created_at as created_moved, p.merged_into as prior_merged_into, p.merged_from as prior_merged_from,
           p.lead_source as prior_lead_source, p.fields_hash as prior_fields_hash,
           c.external_id is not null as current,
           c.created_on::text as cur_created_on,
           ${cur.mergedInto} as cur_merged_into, ${cur.mergedFrom} as cur_merged_from,
           ${cur.leadSource} as cur_lead_source, ${cur.fieldsHash} as cur_fields_hash
    from ${recording} r
    full join ${inMonth} n on n.external_id = r.external_id
    -- What the lead was when last recorded: this month's recording, else the
    -- latest recording of any month that held it (a merge moves a lead
    -- between months).
    left join lateral (
      select b.* from ${schema.baselineLeads} b
      where b.tenant_id = ${tenantId} and b.external_id = coalesce(n.external_id, r.external_id)
      order by coalesce(b.month = ${start}::date and b.recorded_at = r.recorded_at, false) desc, b.recorded_at desc
      limit 1
    ) p on true
    left join ${schema.leads} c on c.tenant_id = ${tenantId} and c.external_id = coalesce(n.external_id, r.external_id)
    where (coalesce(r.counted, false) or coalesce(n.counted, false))
      and row(r.channel, r.counted, r.qualified) is distinct from row(n.channel, n.counted, n.qualified)`);

  const member = (platform: string, qualifiedOnly: boolean, channel: string | null, counted: boolean, qualified: boolean) =>
    counted && (qualifiedOnly ? qualified : true) && (platform === UNATTRIBUTED ? !channel : channel === platform);

  for (const f of frozen) {
    const stage = stages.find((s) => stageMetric(s.key) === f.metric)!;
    const sum = (rows: { channel: string | null; qualified: boolean; n: number }[]) =>
      rows.filter((r) => member(f.platform, stage.qualifiedOnly, r.channel, true, r.qualified)).reduce((n, r) => n + Number(r.n), 0);
    const moves: LeadMove[] = [];
    for (const r of moved) {
      const was = member(f.platform, stage.qualifiedOnly, r.rec_channel, r.rec_counted, r.rec_qualified);
      const is = member(f.platform, stage.qualifiedOnly, r.now_channel, r.now_counted, r.now_qualified);
      if (was === is) continue;
      moves.push({ externalId: r.external_id, change: is ? 'entered' : 'left', ...explainMove(r) });
    }
    out.set(`${f.platform}|${f.metric}`, {
      platform: f.platform,
      metric: f.metric,
      frozen: f.value === null ? null : Number(f.value),
      recorded: recordedCounts ? sum(recordedCounts) : null,
      now: sum(nowCounts),
      moves,
    });
  }
  return out;
}

const quoted = (v: string | null) => (v === null || v === '' ? 'blank' : `“${v}”`);

/** What Salesforce changed on a moved lead, in the order a merge changes them. */
function explainMove(r: MovedRow): { proven: boolean; why: string } {
  if (!r.current) return { proven: true, why: 'deleted in Salesforce' };
  if (!r.prior) {
    return r.cur_merged_from
      ? { proven: true, why: `absorbed ${r.cur_merged_from} in a Salesforce merge` }
      : { proven: false, why: 'in no recorded month, and no merge moved it' };
  }
  const changed: string[] = [];
  if (r.cur_merged_into !== r.prior_merged_into) changed.push(`merged into ${r.cur_merged_into ?? 'nothing'} in Salesforce`);
  if (r.cur_merged_from !== r.prior_merged_from) changed.push(`absorbed ${r.cur_merged_from ?? 'nothing'} in a Salesforce merge`);
  if (r.created_moved) changed.push(`its Salesforce creation date moved to ${r.cur_created_on}`);
  if (r.cur_lead_source !== r.prior_lead_source) {
    changed.push(`Lead Source edited in Salesforce (${quoted(r.prior_lead_source)} → ${quoted(r.cur_lead_source)})`);
  }
  if (r.cur_fields_hash !== r.prior_fields_hash) changed.push('its click, UTM or page fields edited in Salesforce');
  return changed.length > 0
    ? { proven: true, why: changed.join('; ') }
    : { proven: false, why: 'moved with its Salesforce record unchanged — the code moved it' };
}

/**
 * Whether a frozen lead figure's difference is Salesforce's alone: the
 * recording reproduces the frozen value, `computed` is the count now, and
 * every lead that moved is proven.
 */
export function isProvenLeadChange(proof: LeadFigureProof | undefined, frozen: number | null, computed: number | null): boolean {
  if (!proof || proof.recorded === null || frozen === null || computed === null) return false;
  return proof.recorded === frozen && proof.frozen === frozen && proof.now === computed && proof.moves.every((m) => m.proven);
}

/** One line per moved lead, for a log or a frozen version's reason. */
export function describeLeadMoves(proof: LeadFigureProof): string {
  return proof.moves.map((m) => `${m.externalId} ${m.change} (${m.why})`).join('; ');
}
