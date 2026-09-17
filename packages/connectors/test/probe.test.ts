/**
 * These test the probe's judgement, not any Salesforce org.
 *
 * The distinction matters: a stub can only confirm that "the field exists and
 * always arrives null" is reported as blocked rather than shrugged off. Whether
 * that is what the real org does is a question only the real org can answer.
 */
import { describe, expect, it } from 'vitest';
import type { SalesforceClient } from '../src/salesforce/client';
import {
  probeClickIdSurvival,
  probeDeclineReason,
  probeStageHistory,
} from '../src/salesforce/probe';

type Stub = {
  describe?: Record<string, { name: string; fields: unknown[] }>;
  query?: (soql: string) => unknown[];
};

function field(name: string, type = 'string', custom = true) {
  return { name, label: name.replace(/__c$/, '').replace(/_/g, ' '), type, custom };
}

function stubClient(stub: Stub): SalesforceClient {
  return {
    describe: async (sobject: string) =>
      stub.describe?.[sobject] ?? { name: sobject, fields: [] },
    query: async (soql: string) => stub.query?.(soql) ?? [],
  } as unknown as SalesforceClient;
}

describe('click ID survival', () => {
  it('blocks when Lead has no click-ID field at all', async () => {
    const finding = await probeClickIdSurvival(
      stubClient({ describe: { Lead: { name: 'Lead', fields: [field('Email')] } } }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.summary).toMatch(/no click-id field exists on lead/i);
  });

  it('blocks when Opportunity has nowhere to receive it', async () => {
    const finding = await probeClickIdSurvival(
      stubClient({
        describe: {
          Lead: { name: 'Lead', fields: [field('GCLID__c')] },
          Opportunity: { name: 'Opportunity', fields: [field('Amount', 'currency', false)] },
        },
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.remedy).toMatch(/map lead fields/i);
  });

  it('blocks when both fields exist but the value never arrives', async () => {
    // The failure the brief singles out: the mapping is absent, so attribution
    // would be built on a column that is always null.
    const finding = await probeClickIdSurvival(
      stubClient({
        describe: {
          Lead: { name: 'Lead', fields: [field('GCLID__c')] },
          Opportunity: { name: 'Opportunity', fields: [field('GCLID__c')] },
        },
        query: (soql) =>
          soql.includes('FROM Lead')
            ? [{ Id: '00Q1', ConvertedOpportunityId: '0061', GCLID__c: 'abc.123' }]
            : [{ Id: '0061', GCLID__c: null }],
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.summary).toMatch(/arrives null on opportunity every time/i);
  });

  it('blocks when no converted lead has ever carried one', async () => {
    const finding = await probeClickIdSurvival(
      stubClient({
        describe: {
          Lead: { name: 'Lead', fields: [field('GCLID__c')] },
          Opportunity: { name: 'Opportunity', fields: [field('GCLID__c')] },
        },
        query: () => [],
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.remedy).toMatch(/do not assume the mapping works/i);
  });

  it('reports partial carry-through as degraded, not as working', async () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({
      Id: `00Q${i}`,
      ConvertedOpportunityId: `006${i}`,
      GCLID__c: `click-${i}`,
    }));
    const finding = await probeClickIdSurvival(
      stubClient({
        describe: {
          Lead: { name: 'Lead', fields: [field('GCLID__c')] },
          Opportunity: { name: 'Opportunity', fields: [field('GCLID__c')] },
        },
        query: (soql) =>
          soql.includes('FROM Lead')
            ? leads
            : leads.map((l, i) => ({ Id: l.ConvertedOpportunityId, GCLID__c: i < 6 ? l.GCLID__c : null })),
      }),
    );
    expect(finding.status).toBe('degraded');
    expect(finding.remedy).toMatch(/second route/i);
  });

  it('passes only when the value actually arrives', async () => {
    const leads = Array.from({ length: 5 }, (_, i) => ({
      Id: `00Q${i}`,
      ConvertedOpportunityId: `006${i}`,
      GCLID__c: `click-${i}`,
    }));
    const finding = await probeClickIdSurvival(
      stubClient({
        describe: {
          Lead: { name: 'Lead', fields: [field('GCLID__c')] },
          Opportunity: { name: 'Opportunity', fields: [field('GCLID__c')] },
        },
        query: (soql) =>
          soql.includes('FROM Lead')
            ? leads
            : leads.map((l) => ({ Id: l.ConvertedOpportunityId, GCLID__c: l.GCLID__c })),
      }),
    );
    expect(finding.status).toBe('ok');
  });
});

describe('stage timestamps', () => {
  it('blocks when neither history nor date fields exist', async () => {
    const finding = await probeStageHistory(
      stubClient({
        describe: { Opportunity: { name: 'Opportunity', fields: [field('Amount', 'currency', false)] } },
        query: () => {
          throw new Error('OpportunityFieldHistory is not accessible');
        },
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.remedy).toMatch(/not retrospective|history is the only option/i);
  });

  it('blocks when history is readable but tracking was never switched on', async () => {
    const finding = await probeStageHistory(
      stubClient({
        describe: { Opportunity: { name: 'Opportunity', fields: [] } },
        query: (soql) => (soql.includes('COUNT') ? [{ c: 0 }] : []),
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.remedy).toMatch(/set history tracking/i);
  });

  it('accepts real history', async () => {
    const finding = await probeStageHistory(
      stubClient({
        describe: { Opportunity: { name: 'Opportunity', fields: [] } },
        query: (soql) =>
          soql.includes('COUNT') ? [{ c: 4120 }] : [{ CreatedDate: '2025-03-01T00:00:00Z' }],
      }),
    );
    expect(finding.status).toBe('ok');
    expect(finding.summary).toMatch(/4120/);
  });
});

describe('decline reason', () => {
  it('blocks when the field exists but is empty on every lost deal', async () => {
    // Rendering this would produce a breakdown that is 100% "unspecified",
    // which reads as an answer rather than an absence.
    const finding = await probeDeclineReason(
      stubClient({
        describe: {
          Opportunity: { name: 'Opportunity', fields: [field('Decline_Reason__c', 'picklist')] },
        },
        query: () => Array.from({ length: 50 }, (_, i) => ({ Id: `006${i}`, Decline_Reason__c: null })),
      }),
    );
    expect(finding.status).toBe('blocked');
    expect(finding.summary).toMatch(/empty on every closed-lost/i);
  });

  it('calls sparse population degraded and insists the gap is shown', async () => {
    const finding = await probeDeclineReason(
      stubClient({
        describe: {
          Opportunity: { name: 'Opportunity', fields: [field('Decline_Reason__c', 'picklist')] },
        },
        query: () =>
          Array.from({ length: 100 }, (_, i) => ({
            Id: `006${i}`,
            Decline_Reason__c: i < 20 ? 'Time in business' : null,
          })),
      }),
    );
    expect(finding.status).toBe('degraded');
    expect(finding.remedy).toMatch(/not recorded/i);
  });

  it('blocks when no such field exists', async () => {
    const finding = await probeDeclineReason(
      stubClient({ describe: { Opportunity: { name: 'Opportunity', fields: [field('Amount', 'currency', false)] } } }),
    );
    expect(finding.status).toBe('blocked');
  });
});
