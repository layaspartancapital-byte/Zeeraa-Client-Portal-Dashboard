import { describe, expect, it } from 'vitest';
import {
  adjacentConversionRates,
  channelReach,
  reachedByStage,
  stageConversionRate,
  stageVelocity,
  unattributedReach,
  type StageDefinition,
  type StageEvent,
} from '../src/funnel';

const SPARTAN: StageDefinition[] = [
  { key: 'lead', label: 'Lead', position: 1, isOptimizationTarget: false, countsValue: false },
  { key: 'mql', label: 'MQL', position: 2, isOptimizationTarget: false, countsValue: false },
  { key: 'sql', label: 'SQL', position: 3, isOptimizationTarget: false, countsValue: false },
  { key: 'uw_approved', label: 'UW approved', position: 4, isOptimizationTarget: true, countsValue: false },
  { key: 'offer', label: 'Offer', position: 5, isOptimizationTarget: true, countsValue: false },
  { key: 'funded', label: 'Funded', position: 6, isOptimizationTarget: true, countsValue: true },
];

/** A different tenant's shape, run through the same engine. */
const MERIDIAN: StageDefinition[] = [
  { key: 'lead', label: 'Lead', position: 1, isOptimizationTarget: false, countsValue: false },
  { key: 'demo', label: 'Demo', position: 2, isOptimizationTarget: true, countsValue: false },
  { key: 'trial', label: 'Trial', position: 3, isOptimizationTarget: false, countsValue: false },
  { key: 'subscription', label: 'Subscription', position: 4, isOptimizationTarget: true, countsValue: true },
];

function events(spec: Record<string, string[]>): StageEvent[] {
  return Object.entries(spec).flatMap(([opp, stages]) =>
    stages.map((s, i) => ({
      opportunityExternalId: opp,
      stage: s,
      occurredAt: new Date(Date.UTC(2026, 6, 1 + i * 3)),
    })),
  );
}

describe('stage reach', () => {
  it('counts each opportunity once per stage', () => {
    const reach = reachedByStage(
      SPARTAN,
      events({
        A: ['lead', 'mql', 'sql', 'uw_approved', 'offer', 'funded'],
        B: ['lead', 'mql', 'sql', 'uw_approved'],
        C: ['lead', 'mql'],
      }),
    );
    expect(reach.map((r) => [r.stage, r.count])).toEqual([
      ['lead', 3],
      ['mql', 3],
      ['sql', 2],
      ['uw_approved', 2],
      ['offer', 1],
      ['funded', 1],
    ]);
  });

  it('carries the origin, so a computed stage is not shown as observed', () => {
    // MQL has no timestamp field in Salesforce; it is derived from the
    // qualification minimums. The funnel view has to be able to say so.
    const reach = reachedByStage(SPARTAN, events({ A: ['lead', 'mql'] }), { mql: 'computed' });
    expect(reach.find((r) => r.stage === 'mql')?.origin).toBe('computed');
    expect(reach.find((r) => r.stage === 'lead')?.origin).toBe('observed');
  });
});

describe('conversion rates', () => {
  it('computes the offer rate as one instance of the generic engine', () => {
    const reach = reachedByStage(
      SPARTAN,
      events({
        A: ['uw_approved', 'offer'],
        B: ['uw_approved'],
        C: ['uw_approved', 'offer'],
        D: ['uw_approved'],
      }),
    );
    expect(stageConversionRate(reach, 'uw_approved', 'offer')).toEqual({
      from: 'uw_approved',
      to: 'offer',
      numerator: 2,
      denominator: 4,
      rate: 0.5,
    });
  });

  it('returns null, not zero, when nothing reached the earlier stage', () => {
    // "No deals reached underwriting" and "every deal was declined" are
    // opposite findings; a zero renders them identically.
    const reach = reachedByStage(SPARTAN, []);
    expect(stageConversionRate(reach, 'uw_approved', 'offer').rate).toBeNull();
  });

  it('produces one rate per gap, in stage order', () => {
    const rates = adjacentConversionRates(SPARTAN, reachedByStage(SPARTAN, []));
    expect(rates.map((r) => `${r.from}->${r.to}`)).toEqual([
      'lead->mql',
      'mql->sql',
      'sql->uw_approved',
      'uw_approved->offer',
      'offer->funded',
    ]);
  });

  it('runs a completely different funnel shape with no code change', () => {
    const reach = reachedByStage(
      MERIDIAN,
      events({ A: ['lead', 'demo', 'trial', 'subscription'], B: ['lead', 'demo'] }),
    );
    expect(adjacentConversionRates(MERIDIAN, reach).map((r) => r.rate)).toEqual([1, 0.5, 1]);
  });
});

describe('stage velocity', () => {
  it('takes the median so one stalled deal does not move it', () => {
    const rows: StageEvent[] = [
      { opportunityExternalId: 'A', stage: 'lead', occurredAt: new Date('2026-07-01') },
      { opportunityExternalId: 'A', stage: 'funded', occurredAt: new Date('2026-07-03') },
      { opportunityExternalId: 'B', stage: 'lead', occurredAt: new Date('2026-07-01') },
      { opportunityExternalId: 'B', stage: 'funded', occurredAt: new Date('2026-07-05') },
      { opportunityExternalId: 'C', stage: 'lead', occurredAt: new Date('2026-07-01') },
      { opportunityExternalId: 'C', stage: 'funded', occurredAt: new Date('2027-04-01') },
    ];
    expect(stageVelocity(rows, 'lead', 'funded')).toEqual({ medianDays: 4, sampleSize: 3 });
  });

  it('uses the earliest occurrence when a stage repeats', () => {
    const rows: StageEvent[] = [
      { opportunityExternalId: 'A', stage: 'lead', occurredAt: new Date('2026-07-01') },
      { opportunityExternalId: 'A', stage: 'offer', occurredAt: new Date('2026-07-10') },
      { opportunityExternalId: 'A', stage: 'offer', occurredAt: new Date('2026-07-04') },
    ];
    expect(stageVelocity(rows, 'lead', 'offer').medianDays).toBe(3);
  });

  it('excludes deals whose timestamps run backwards rather than averaging them in', () => {
    const rows: StageEvent[] = [
      { opportunityExternalId: 'A', stage: 'lead', occurredAt: new Date('2026-07-10') },
      { opportunityExternalId: 'A', stage: 'funded', occurredAt: new Date('2026-07-01') },
    ];
    expect(stageVelocity(rows, 'lead', 'funded')).toEqual({ medianDays: null, sampleSize: 0 });
  });

  it('reports no sample rather than zero days when nothing reached both', () => {
    expect(stageVelocity([], 'lead', 'funded')).toEqual({ medianDays: null, sampleSize: 0 });
  });
});

describe('channelReach', () => {
  const CHANNELS: Record<string, string | null> = {
    A: 'google_ads',
    B: 'google_ads',
    C: 'meta',
    D: null,
  };
  const channelOf = (id: string) => CHANNELS[id] ?? null;

  it("scopes both halves of a rate to the same channel", () => {
    // Four leads, of which two are Google Ads. One Google Ads lead reaches
    // offer, as does the Meta lead. Google Ads' offer rate is 1/2, not 2/4 and
    // not 1/4 — a channel's numerator over a channel's denominator.
    const timeline = [
      ...events({ A: ['lead', 'offer'] }),
      ...events({ B: ['lead'] }),
      ...events({ C: ['lead', 'offer'] }),
      ...events({ D: ['lead'] }),
    ];

    const google = channelReach(SPARTAN, timeline, channelOf, 'google_ads');
    const rate = stageConversionRate(google, 'lead', 'offer');
    expect(rate).toEqual({ from: 'lead', to: 'offer', numerator: 1, denominator: 2, rate: 0.5 });

    // The same events across everybody would give a different, meaningless
    // number for this channel.
    expect(stageConversionRate(reachedByStage(SPARTAN, timeline), 'lead', 'offer').rate).toBe(0.5);
    expect(stageConversionRate(reachedByStage(SPARTAN, timeline), 'lead', 'offer').denominator).toBe(4);
  });

  it('gives deals no channel can claim their own population', () => {
    const timeline = [
      ...events({ A: ['lead', 'offer'] }),
      ...events({ D: ['lead'] }),
    ];
    const orphan = unattributedReach(SPARTAN, timeline, channelOf);
    expect(orphan.find((r) => r.stage === 'lead')?.count).toBe(1);
    expect(orphan.find((r) => r.stage === 'offer')?.count).toBe(0);
    // And it is not inside any channel's figures.
    expect(
      channelReach(SPARTAN, timeline, channelOf, 'google_ads').find((r) => r.stage === 'lead')?.count,
    ).toBe(1);
  });

  it('returns a null rate for a channel with nothing at the earlier stage', () => {
    const reach = channelReach(SPARTAN, events({ C: ['lead'] }), channelOf, 'google_ads');
    expect(stageConversionRate(reach, 'lead', 'offer').rate).toBeNull();
  });
});
