/**
 * The funnel engine.
 *
 * Reads configured stages and stage events. It knows nothing about merchant
 * cash advances, underwriting or offers — "offer rate" is
 * `stageConversionRate('uw_approved', 'offer')` over whatever stages a tenant
 * happens to have configured.
 */

export type StageDefinition = {
  key: string;
  label: string;
  position: number;
  isOptimizationTarget: boolean;
  countsValue: boolean;
  /**
   * Where the stage is counted from. `stage_events` is keyed by opportunity;
   * `leads` counts the inbound lead population, which is a different grain and
   * usually a much larger number.
   *
   * It matters to a reader, not only to the query: a conversion rate that
   * crosses a grain boundary — leads into applications — is a different kind of
   * statement from one inside a grain, and the funnel says so where it happens.
   */
  source?: 'stage_events' | 'leads' | 'qualified_leads';
};

export type StageEvent = {
  opportunityExternalId: string;
  stage: string;
  occurredAt: Date;
};

/**
 * How a stage's timestamp was established. Carried through to the UI, because a
 * stage the platform inferred and a stage the CRM recorded are different kinds
 * of fact and should not be presented identically.
 */
export type StageOrigin = 'observed' | 'computed';

export type StageReach = {
  stage: string;
  /** Opportunities that reached this stage at any point in the window. */
  count: number;
  origin: StageOrigin;
};

export function reachedByStage(
  stages: readonly StageDefinition[],
  events: readonly StageEvent[],
  origins: Readonly<Record<string, StageOrigin>> = {},
): StageReach[] {
  const byStage = new Map<string, Set<string>>();
  for (const event of events) {
    let set = byStage.get(event.stage);
    if (!set) byStage.set(event.stage, (set = new Set()));
    set.add(event.opportunityExternalId);
  }

  return [...stages]
    .sort((a, b) => a.position - b.position)
    .map((stage) => ({
      stage: stage.key,
      count: byStage.get(stage.key)?.size ?? 0,
      origin: origins[stage.key] ?? 'observed',
    }));
}

/**
 * Which channel a deal is attributed to, or null when none is.
 *
 * A lookup rather than a field on the event: attribution is resolved per model,
 * and the same opportunity can belong to a different channel under first touch
 * than under last touch.
 */
export type ChannelOf = (opportunityExternalId: string) => string | null;

/**
 * Stage reach for one channel.
 *
 * The rule this exists to enforce: a channel's rate divides that channel's
 * numerator by that channel's denominator. A channel's offer rate is offers
 * attributed to it over leads attributed to it — never over the total, which
 * would mix a channel's numerator with everybody's denominator and produce a
 * number that falls whenever another channel has a good month.
 *
 * It is a named function rather than a `filter` at each call site so that the
 * filtering is impossible to leave out by accident, and so the one place it
 * happens is the one place to read when a rate looks wrong.
 */
export function channelReach(
  stages: readonly StageDefinition[],
  events: readonly StageEvent[],
  channelOf: ChannelOf,
  channel: string,
  origins: Readonly<Record<string, StageOrigin>> = {},
): StageReach[] {
  return reachedByStage(
    stages,
    events.filter((e) => channelOf(e.opportunityExternalId) === channel),
    origins,
  );
}

/**
 * Stage reach for deals no channel can claim.
 *
 * Its own population, reported as its own row. Folding these into a channel
 * would overstate that channel; dropping them entirely would quietly shrink
 * the funnel and make every channel look like the whole business.
 */
export function unattributedReach(
  stages: readonly StageDefinition[],
  events: readonly StageEvent[],
  channelOf: ChannelOf,
  origins: Readonly<Record<string, StageOrigin>> = {},
): StageReach[] {
  return reachedByStage(
    stages,
    events.filter((e) => channelOf(e.opportunityExternalId) === null),
    origins,
  );
}

export type ConversionRate = {
  from: string;
  to: string;
  numerator: number;
  denominator: number;
  /** Null when nothing reached the earlier stage — not zero. */
  rate: number | null;
};

/**
 * The generic engine. Every named rate in the product is one call to this.
 *
 * Returns null rather than zero for an empty denominator: "no deals reached
 * underwriting, so there is no approval rate" and "every deal that reached
 * underwriting was declined" are opposite findings, and a zero would render
 * them identically.
 *
 * Whatever population `reach` describes is the population the rate describes.
 * For a per-channel rate that must be `channelReach` — both halves of the
 * fraction drawn from the same channel — and the caller cannot fix a mixed
 * population afterwards, because by this point the counts are integers with
 * nothing left to say where they came from.
 */
export function stageConversionRate(
  reach: readonly StageReach[],
  from: string,
  to: string,
): ConversionRate {
  const denominator = reach.find((r) => r.stage === from)?.count ?? 0;
  const numerator = reach.find((r) => r.stage === to)?.count ?? 0;
  return {
    from,
    to,
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
}

/** The rate between each adjacent pair — what renders in the gaps (§9.3). */
export function adjacentConversionRates(
  stages: readonly StageDefinition[],
  reach: readonly StageReach[],
): ConversionRate[] {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const rates: ConversionRate[] = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    rates.push(stageConversionRate(reach, ordered[i]!.key, ordered[i + 1]!.key));
  }
  return rates;
}

/**
 * Where each record that reached a stage in the window has got to since.
 *
 * `size` is how many records reached `from` in the window; `reached[to]` is
 * how many of *those same records* have reached `to` at any time so far. The
 * numerator is drawn from the denominator's records, so no rate built on it can
 * exceed 100% — which a ratio of two period counts can, because a deal can
 * reach Offer this period on an approval from last quarter.
 *
 * Plain data rather than sets, so a report carrying it can be cached.
 */
export type StageCohorts = Record<string, { size: number; reached: Record<string, number> }>;

/**
 * Builds the cohorts for every ordered pair of stages.
 *
 * `inWindow` is the records reaching each stage in the window, and
 * `hasReached(stage, id)` answers whether record `id` has reached `stage` at
 * any time. The caller owns the grain: a lead-grain cohort asked about an
 * opportunity stage answers through the opportunity the lead became.
 */
export function stageCohorts(
  stages: readonly StageDefinition[],
  inWindow: ReadonlyMap<string, ReadonlySet<string>>,
  hasReached: (stage: string, id: string) => boolean,
): StageCohorts {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const cohorts: StageCohorts = {};
  for (const [i, from] of ordered.entries()) {
    const ids = inWindow.get(from.key) ?? new Set<string>();
    const reached: Record<string, number> = {};
    for (const to of ordered.slice(i + 1)) {
      let n = 0;
      for (const id of ids) if (hasReached(to.key, id)) n += 1;
      reached[to.key] = n;
    }
    cohorts[from.key] = { size: ids.size, reached };
  }
  return cohorts;
}

/**
 * The funnel's stage-to-stage rate: of the records that reached `from` in the
 * window, the share that have reached `to` so far. Null for an empty cohort.
 */
export function cohortConversionRate(
  cohorts: StageCohorts,
  from: string,
  to: string,
): ConversionRate {
  const cohort = cohorts[from];
  const denominator = cohort?.size ?? 0;
  const numerator = cohort?.reached[to] ?? 0;
  return { from, to, numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

/**
 * Median days between two stages, over opportunities that reached both.
 *
 * Median rather than mean: one deal that sat in underwriting for nine months
 * should not move the number that describes the typical deal.
 */
export function stageVelocity(
  events: readonly StageEvent[],
  from: string,
  to: string,
): { medianDays: number | null; sampleSize: number } {
  const firstAt = new Map<string, Map<string, Date>>();
  for (const event of events) {
    let stages = firstAt.get(event.opportunityExternalId);
    if (!stages) firstAt.set(event.opportunityExternalId, (stages = new Map()));
    const existing = stages.get(event.stage);
    if (!existing || event.occurredAt < existing) stages.set(event.stage, event.occurredAt);
  }

  const durations: number[] = [];
  for (const stages of firstAt.values()) {
    const start = stages.get(from);
    const end = stages.get(to);
    if (!start || !end) continue;
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    // A negative duration means the CRM recorded the later stage first. That is
    // a data quality signal, not a velocity, so it is excluded rather than
    // averaged in.
    if (days >= 0) durations.push(days);
  }

  if (durations.length === 0) return { medianDays: null, sampleSize: 0 };
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianDays =
    durations.length % 2 === 0 ? (durations[mid - 1]! + durations[mid]!) / 2 : durations[mid]!;
  return { medianDays, sampleSize: durations.length };
}
