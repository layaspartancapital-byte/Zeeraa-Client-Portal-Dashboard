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
