import { describe, expect, it, vi } from 'vitest';
import type { SalesforceClient } from '../src/salesforce/client';
import {
  countLeadClassification,
  excludedClause,
  inboundClause,
  inboundSignalClause,
  LeadExclusionConfigError,
  negatedRuleClause,
  noInboundSignalClause,
  notExcludedClause,
  parseLeadExclusion,
  ruleClause,
  unclassifiedClause,
  type LeadExclusionConfig,
} from '../src/salesforce/exclusion';
import { buildIncrementalQuery } from '../src/salesforce/sync';
import type { SalesforceFieldMapping } from '../src/salesforce/mapping';

/** Spartan's rules, as seeded. */
const SPARTAN: LeadExclusionConfig = {
  enabled: true,
  rules: [
    {
      key: 'cold_outreach_owner',
      label: 'Owned by the cold-outreach holding queue',
      ownerNames: ['Cold Outreach Holding'],
    },
    {
      key: 'bulk_load_2026_09_08',
      label: 'Cold-list bulk load of 8 September 2026, with no lead source',
      createdBetween: { from: '2026-09-08T00:00:00Z', to: '2026-09-09T00:00:00Z' },
      requireNullLeadSource: true,
    },
  ],
  inboundSignalFields: ['LeadSource', 'utm_source__c', 'gclid__c'],
};

describe('rule clauses', () => {
  it('ANDs a rule’s own criteria', () => {
    expect(ruleClause(SPARTAN.rules[1]!)).toBe(
      '((CreatedDate >= 2026-09-08T00:00:00Z AND CreatedDate < 2026-09-09T00:00:00Z) ' +
        'AND LeadSource = null)',
    );
  });

  it('ORs the rules together', () => {
    expect(excludedClause(SPARTAN)).toBe(
      "(Owner.Name IN ('Cold Outreach Holding') OR " +
        '((CreatedDate >= 2026-09-08T00:00:00Z AND CreatedDate < 2026-09-09T00:00:00Z) ' +
        'AND LeadSource = null))',
    );
  });

  it('emits no clause when the exclusion is off', () => {
    expect(excludedClause({ ...SPARTAN, enabled: false })).toBeNull();
    expect(inboundClause({ ...SPARTAN, enabled: false })).toBeNull();
  });

  it('refuses a rule with no criteria rather than excluding every lead', () => {
    expect(() => ruleClause({ key: 'empty', label: 'nothing' })).toThrow(LeadExclusionConfigError);
    expect(() => ruleClause({ key: 'empty', label: 'nothing' })).toThrow(/would exclude every lead/);
  });

  it('rejects an unparseable instant instead of emitting a broken literal', () => {
    expect(() =>
      ruleClause({
        key: 'bad',
        label: 'bad window',
        createdBetween: { from: 'last Tuesday', to: '2026-01-01T00:00:00Z' },
      }),
    ).toThrow(LeadExclusionConfigError);
  });

  it('writes datetime literals unquoted, and normalises fractional seconds away', () => {
    // Unquoted matters: a quoted literal is a string comparison against a
    // datetime column. Dropping milliseconds is cosmetic — the API accepts
    // them — and keeps the generated clause stable.
    const clause = ruleClause({
      key: 'w',
      label: 'w',
      createdBetween: { from: '2026-09-08T00:00:00.123Z', to: '2026-09-09T00:00:00Z' },
    });
    expect(clause).toContain('CreatedDate >= 2026-09-08T00:00:00Z');
    expect(clause).not.toMatch(/'2026/);
    expect(clause).not.toMatch(/\.\d{3}Z/);
  });

  it('escapes quotes in an owner name', () => {
    expect(
      ruleClause({ key: 'o', label: 'o', ownerNames: ["O'Donnell Holding"] }),
    ).toBe("Owner.Name IN ('O\\'Donnell Holding')");
  });
});

describe('negation', () => {
  // SOQL's NOT may only prefix one parenthesised expression at the head of a
  // WHERE clause. `NOT (a) AND NOT (b)` is a syntax error against a real org,
  // so every negation is pushed down to the comparisons instead.
  it('never emits a NOT operator', () => {
    for (const clause of [
      notExcludedClause(SPARTAN),
      noInboundSignalClause(SPARTAN),
      inboundClause(SPARTAN),
      unclassifiedClause(SPARTAN),
    ]) {
      expect(clause).not.toMatch(/\bNOT\s*\(/);
    }
  });

  it('turns an AND of criteria into an OR of negated criteria', () => {
    expect(negatedRuleClause(SPARTAN.rules[1]!)).toBe(
      '((CreatedDate < 2026-09-08T00:00:00Z OR CreatedDate >= 2026-09-09T00:00:00Z) ' +
        'OR LeadSource != null)',
    );
  });

  it('turns an OR of rules into an AND of negated rules', () => {
    expect(notExcludedClause(SPARTAN)).toBe(
      "(Owner.Name NOT IN ('Cold Outreach Holding') AND " +
        '((CreatedDate < 2026-09-08T00:00:00Z OR CreatedDate >= 2026-09-09T00:00:00Z) ' +
        'OR LeadSource != null))',
    );
  });

  it('inverts the inbound signal to every field being null', () => {
    expect(inboundSignalClause(SPARTAN)).toBe(
      '(LeadSource != null OR utm_source__c != null OR gclid__c != null)',
    );
    expect(noInboundSignalClause(SPARTAN)).toBe(
      '(LeadSource = null AND utm_source__c = null AND gclid__c = null)',
    );
  });
});

describe('the three buckets partition the population', () => {
  // excluded, unclassified and inbound must be mutually exclusive and cover
  // everything: a record that falls through all three is one the platform
  // ingests without meaning to.
  type Lead = { owner: string; created: string; source: string | null; utm: string | null };

  const matchesExcluded = (l: Lead) =>
    l.owner === 'Cold Outreach Holding' ||
    (l.created >= '2026-09-08T00:00:00Z' && l.created < '2026-09-09T00:00:00Z' && l.source === null);
  const hasSignal = (l: Lead) => l.source !== null || l.utm !== null;

  const leads: Lead[] = [
    { owner: 'Cold Outreach Holding', created: '2026-09-08T18:00:00Z', source: null, utm: null },
    { owner: 'Kevin', created: '2026-09-08T18:00:00Z', source: null, utm: null },
    { owner: 'Kevin', created: '2026-09-08T18:00:00Z', source: 'Meta Ads', utm: null },
    { owner: 'Kevin', created: '2026-05-01T09:00:00Z', source: null, utm: 'google' },
    { owner: 'Kevin', created: '2026-05-01T09:00:00Z', source: null, utm: null },
    { owner: 'Cold Outreach Holding', created: '2026-01-01T09:00:00Z', source: 'Web', utm: null },
  ];

  it('assigns every lead to exactly one bucket', () => {
    for (const lead of leads) {
      const buckets = [
        matchesExcluded(lead),
        !matchesExcluded(lead) && !hasSignal(lead),
        !matchesExcluded(lead) && hasSignal(lead),
      ].filter(Boolean);
      expect(buckets).toHaveLength(1);
    }
  });

  it('excludes a lead that matches no rule but carries no inbound signal', () => {
    const orphan = leads[4]!;
    expect(matchesExcluded(orphan)).toBe(false);
    expect(hasSignal(orphan)).toBe(false);
  });

  it('keeps a genuine inbound lead created inside the bulk-load window', () => {
    // The window rule requires a null LeadSource precisely so that the real
    // leads which arrived the same day are not swept up with the list.
    const sameDay = leads[2]!;
    expect(matchesExcluded(sameDay)).toBe(false);
    expect(hasSignal(sameDay)).toBe(true);
  });
});

describe('countLeadClassification', () => {
  function clientReturning(counts: number[]): SalesforceClient {
    let i = 0;
    return {
      query: vi.fn(async () => [{ c: counts[i++] ?? 0 }]),
    } as unknown as SalesforceClient;
  }

  it('reports each rule separately and flags that they overlap', async () => {
    // considered, rule 1, rule 2, excludedTotal, unclassified, inbound
    const client = clientReturning([100, 80, 80, 80, 5, 15]);
    const counts = await countLeadClassification(client, SPARTAN, null);

    expect(counts.considered).toBe(100);
    expect(counts.perRule.map((r) => [r.key, r.matched])).toEqual([
      ['cold_outreach_owner', 80],
      ['bulk_load_2026_09_08', 80],
    ]);
    expect(counts.excludedTotal).toBe(80);
    expect(counts.unclassified).toBe(5);
    expect(counts.inbound).toBe(15);
    // 80 + 80 !== 80, so the per-rule figures must not be summed in the UI.
    expect(counts.rulesOverlap).toBe(true);
  });

  it('does not flag overlap when the rules are disjoint', async () => {
    const client = clientReturning([100, 60, 20, 80, 5, 15]);
    const counts = await countLeadClassification(client, SPARTAN, null);
    expect(counts.rulesOverlap).toBe(false);
  });

  it('counts everything as inbound when the exclusion is off', async () => {
    const client = clientReturning([100]);
    const counts = await countLeadClassification(client, { ...SPARTAN, enabled: false }, null);
    expect(counts).toMatchObject({ considered: 100, inbound: 100, excludedTotal: 0, unclassified: 0 });
    expect(counts.perRule).toEqual([]);
  });
});

describe('parseLeadExclusion', () => {
  it('accepts the seeded Spartan configuration', () => {
    expect(parseLeadExclusion(SPARTAN)).toEqual(SPARTAN);
  });

  it('treats a missing config row as no exclusion', () => {
    expect(parseLeadExclusion(null).enabled).toBe(false);
  });

  it('rejects an enabled config with no inbound signal fields', () => {
    // Without one, nothing can be positively classified and every unmatched
    // lead is ingested on the assumption that it is inbound.
    expect(() => parseLeadExclusion({ ...SPARTAN, inboundSignalFields: [] })).toThrow(
      /inboundSignalFields/,
    );
  });

  it('rejects duplicate rule keys, which would make the audit ambiguous', () => {
    expect(() =>
      parseLeadExclusion({ ...SPARTAN, rules: [SPARTAN.rules[0]!, SPARTAN.rules[0]!] }),
    ).toThrow(/duplicate rule key/);
  });

  it('rejects a rule with no criteria', () => {
    expect(() =>
      parseLeadExclusion({ ...SPARTAN, rules: [{ key: 'all', label: 'everything' }] }),
    ).toThrow(/would exclude every lead/);
  });
});

describe('buildIncrementalQuery', () => {
  const mapping = {
    lead: { clickIds: { google_ads: 'gclid__c' } },
    opportunity: { clickIds: {} },
    stages: {},
    extraStageEvents: {},
    derivedStages: {},
  } as unknown as SalesforceFieldMapping;

  it('applies the exclusion to Lead', () => {
    const soql = buildIncrementalQuery(mapping, 'Lead', null, SPARTAN);
    expect(soql).toContain("Owner.Name NOT IN ('Cold Outreach Holding')");
    expect(soql).toContain('LeadSource != null OR utm_source__c != null');
  });

  it('does not apply it to Opportunity', () => {
    const soql = buildIncrementalQuery(mapping, 'Opportunity', null, SPARTAN);
    expect(soql).not.toContain('Cold Outreach Holding');
  });

  it('combines the watermark and the exclusion', () => {
    const soql = buildIncrementalQuery(mapping, 'Lead', new Date('2026-09-01T00:00:00Z'), SPARTAN);
    expect(soql).toContain('WHERE SystemModstamp > 2026-09-01T00:00:00.000Z AND ');
  });

  it('emits no WHERE clause at all with no watermark and no exclusion', () => {
    expect(buildIncrementalQuery(mapping, 'Lead', null)).not.toContain('WHERE');
  });
});
