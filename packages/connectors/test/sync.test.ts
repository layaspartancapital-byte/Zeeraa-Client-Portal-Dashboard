import { describe, expect, it } from 'vitest';
import type { SalesforceClient } from '../src/salesforce/client';
import type { SalesforceFieldMapping } from '../src/salesforce/mapping';
import { validateMapping } from '../src/salesforce/mapping';
import {
  buildIncrementalQuery,
  deriveQualificationStageEvent,
  extractStageEvents,
  normalizeLead,
  normalizeOpportunity,
  pickClickId,
  reconcileDeletesAndMerges,
} from '../src/salesforce/sync';

/** Spartan's mapping, as confirmed by the probe. */
const SPARTAN: SalesforceFieldMapping = {
  lead: {
    clickIds: { google_ads: 'GCLID__c', microsoft_ads: 'MSCLKID__c' },
    utmSource: 'UTM_Source__c',
    selfReportedRevenue: 'Monthly_Revenue__c',
    selfReportedTimeInBusinessMonths: 'Time_In_Business__c',
    selfReportedAnnualRevenue: 'Annual_Revenue__c',
    state: 'State',
  },
  opportunity: {
    // Empty: the Opportunity click-ID fields do not exist yet.
    clickIds: {},
    amount: 'Amount',
    fundedAmount: 'csbs__Funded_Amount__c',
    declineReason: 'csbs__Decline_Reason__c',
    state: 'csbs__State__c',
  },
  stages: {
    sql: 'csbs__Underwriting_Date_Time__c',
    uw_approved: 'csbs__Approved_Date_Time__c',
    offer: 'Offer_Received_Date_Time__c',
    funded: 'csbs__Funded_Date_Time__c',
  },
  extraStageEvents: {
    declined: 'csbs__Declined_Date_Time__c',
    contract_requested: 'Contract_Requested_Date_Time__c',
  },
  derivedStages: { lead: 'opportunity_created', mql: 'qualification_minimums' },
};

describe('click ID selection', () => {
  it('is deterministic when a lead carries more than one', () => {
    // Enumeration order must not decide attribution.
    const picked = pickClickId(
      { GCLID__c: 'g-1', MSCLKID__c: 'm-1' },
      SPARTAN.lead.clickIds,
      ['microsoft_ads', 'google_ads'],
    );
    expect(picked).toMatchObject({ clickId: 'm-1', clickIdType: 'microsoft_ads' });
    expect(picked.all).toEqual({ google_ads: 'g-1', microsoft_ads: 'm-1' });
  });

  it('keeps every click ID, not only the winner', () => {
    // Both models need the full set; last-touch cannot be reconstructed later
    // from a single stored value.
    expect(pickClickId({ GCLID__c: 'g', MSCLKID__c: 'm' }, SPARTAN.lead.clickIds, []).all).toEqual({
      google_ads: 'g',
      microsoft_ads: 'm',
    });
  });

  it('returns nulls rather than an empty string when none is present', () => {
    expect(pickClickId({ GCLID__c: '  ' }, SPARTAN.lead.clickIds, [])).toMatchObject({
      clickId: null,
      clickIdType: null,
    });
  });
});

describe('lead normalisation', () => {
  const record = {
    Id: '00Q1',
    CreatedDate: '2026-08-01T14:30:00.000+0000',
    GCLID__c: 'click-abc',
    UTM_Source__c: 'google',
    Monthly_Revenue__c: '42000.50',
    Time_In_Business__c: 30,
    State: 'NY',
    IsConverted: true,
    ConvertedOpportunityId: '0061',
    MasterRecordId: null,
  };

  it('maps the fields that exist and leaves the rest null', () => {
    const lead = normalizeLead(record, SPARTAN);
    expect(lead).toMatchObject({
      externalId: '00Q1',
      clickId: 'click-abc',
      clickIdType: 'google_ads',
      utmSource: 'google',
      selfReportedRevenue: 42000.5,
      selfReportedTimeInBusiness: 30,
      state: 'NY',
      isConverted: true,
      convertedOpportunityId: '0061',
      mergedInto: null,
    });
    expect(lead.utmMedium).toBeNull();
    expect(lead.industry).toBeNull();
  });

  it('records where a merged lead went', () => {
    expect(normalizeLead({ ...record, MasterRecordId: '00Q9' }, SPARTAN).mergedInto).toBe('00Q9');
  });
});

describe('stage events', () => {
  const opportunity = {
    Id: '0061',
    CreatedDate: '2026-08-01T10:00:00.000+0000',
    StageName: 'Declined',
    'csbs__Underwriting_Date_Time__c': '2026-08-03T09:00:00.000+0000',
    'csbs__Approved_Date_Time__c': '2026-08-05T09:00:00.000+0000',
    'Offer_Received_Date_Time__c': '2026-08-06T09:00:00.000+0000',
    'csbs__Declined_Date_Time__c': '2026-08-09T09:00:00.000+0000',
    'csbs__Funded_Date_Time__c': null,
    'Contract_Requested_Date_Time__c': null,
  };

  it('records every stage the deal passed through, not just where it ended', () => {
    // The opportunity now sits at Declined. A funnel built from StageName alone
    // would lose the fact that it reached underwriting, approval and offer.
    const events = extractStageEvents(opportunity, SPARTAN);
    expect(events.map((e) => e.stage)).toEqual([
      'lead',
      'sql',
      'uw_approved',
      'offer',
      'declined',
    ]);
  });

  it('orders events by time', () => {
    const events = extractStageEvents(opportunity, SPARTAN);
    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('emits nothing for a stage whose field is empty', () => {
    expect(extractStageEvents(opportunity, SPARTAN).some((e) => e.stage === 'funded')).toBe(false);
  });

  it('marks a derived stage as computed, not observed', () => {
    const lead = extractStageEvents(opportunity, SPARTAN).find((e) => e.stage === 'lead');
    expect(lead?.origin).toBe('computed');
    expect(extractStageEvents(opportunity, SPARTAN).find((e) => e.stage === 'offer')?.origin).toBe(
      'observed',
    );
  });

  it('keeps events that are not funnel stages', () => {
    expect(extractStageEvents(opportunity, SPARTAN).some((e) => e.stage === 'declined')).toBe(true);
  });
});

describe('the derived MQL event', () => {
  const bar = {
    minMonthsInBusiness: 12,
    minMonthlyRevenue: 10_000,
    revenueDisagreementTolerance: 0.1,
  };
  const base = normalizeLead(
    {
      Id: '00Q1',
      CreatedDate: '2026-08-01T14:30:00.000+0000',
      Monthly_Revenue__c: 42_000,
      Time_In_Business__c: 30,
    },
    SPARTAN,
  );

  it('dates MQL to the lead’s creation and marks it computed', () => {
    const event = deriveQualificationStageEvent(base, '0061', 'mql', bar);
    expect(event).toMatchObject({ stage: 'mql', origin: 'computed' });
    expect(event?.occurredAt.toISOString()).toBe('2026-08-01T14:30:00.000Z');
  });

  it('qualifies on an annual figure alone', () => {
    const annualOnly = normalizeLead(
      {
        Id: '00Q2',
        CreatedDate: '2026-08-01T14:30:00.000+0000',
        Annual_Revenue__c: 240_000,
        Time_In_Business__c: 30,
      },
      SPARTAN,
    );
    expect(deriveQualificationStageEvent(annualOnly, '0062', 'mql', bar)).toMatchObject({
      stage: 'mql',
      origin: 'computed',
    });
  });

  it('emits nothing for a lead that fails the minimums', () => {
    expect(
      deriveQualificationStageEvent({ ...base, selfReportedRevenue: 500 }, '0061', 'mql', bar),
    ).toBeNull();
  });

  it('emits nothing when qualification cannot be determined', () => {
    // Guessing either way here moves a headline conversion rate.
    expect(
      deriveQualificationStageEvent(
        { ...base, selfReportedRevenue: null },
        '0061',
        'mql',
        bar,
      ),
    ).toBeNull();
  });
});

describe('incremental query', () => {
  it('filters on SystemModstamp and orders by it', () => {
    const soql = buildIncrementalQuery(SPARTAN, 'Opportunity', new Date('2026-09-01T00:00:00Z'));
    expect(soql).toContain('WHERE SystemModstamp > 2026-09-01T00:00:00.000Z');
    expect(soql).toContain('ORDER BY SystemModstamp ASC');
    expect(soql).toContain('csbs__Approved_Date_Time__c');
  });

  it('omits the filter on a first full pull', () => {
    expect(buildIncrementalQuery(SPARTAN, 'Lead', null)).not.toContain('WHERE');
  });

  it('never selects a field the mapping does not name', () => {
    expect(buildIncrementalQuery(SPARTAN, 'Opportunity', null)).not.toContain('GCLID__c');
  });
});

describe('deletes and merges', () => {
  function stub(deleted: string[], merged: { Id: string; MasterRecordId: string | null }[]) {
    return {
      getDeleted: async () => ({
        deletedRecords: deleted.map((id) => ({ id, deletedDate: '2026-09-10T00:00:00Z' })),
        earliestDateAvailable: '2026-08-18T00:00:00Z',
        latestDateCovered: '2026-09-17T00:00:00Z',
      }),
      query: async () => merged,
    } as unknown as SalesforceClient;
  }

  it('separates a merge from a deletion', () => {
    // Both arrive via getDeleted. Treating a merge as a deletion throws away
    // the click that produced the deal; the record did not disappear, it became
    // part of another one.
    return expect(
      reconcileDeletesAndMerges(
        stub(['00Q1', '00Q2'], [{ Id: '00Q2', MasterRecordId: '00Q9' }]),
        'Lead',
        new Date('2026-08-18T00:00:00Z'),
      ),
    ).resolves.toEqual({
      deletedIds: ['00Q1'],
      merges: [{ loserId: '00Q2', survivorId: '00Q9' }],
    });
  });

  it('does not process a merged record twice', async () => {
    const result = await reconcileDeletesAndMerges(
      stub(['00Q2'], [{ Id: '00Q2', MasterRecordId: '00Q9' }]),
      'Lead',
      new Date('2026-08-18T00:00:00Z'),
    );
    expect(result.deletedIds).toEqual([]);
    expect(result.merges).toHaveLength(1);
  });

  it('skips the merge lookup entirely when nothing was deleted', async () => {
    let queried = false;
    const client = {
      getDeleted: async () => ({
        deletedRecords: [],
        earliestDateAvailable: '',
        latestDateCovered: '',
      }),
      query: async () => {
        queried = true;
        return [];
      },
    } as unknown as SalesforceClient;
    await reconcileDeletesAndMerges(client, 'Lead', new Date());
    expect(queried).toBe(false);
  });
});

describe('mapping validation', () => {
  function describeStub(leadFields: string[], oppFields: string[]) {
    return {
      describe: async (object: string) => ({
        name: object,
        fields: (object === 'Lead' ? leadFields : oppFields).map((name) => ({
          name,
          label: name,
          type: 'string',
          custom: true,
        })),
      }),
    } as unknown as SalesforceClient;
  }

  it('reports a field the integration user cannot see as blocking', async () => {
    // Field-level security and a non-existent field look identical over the
    // API, so both are reported the same way rather than guessed between.
    const result = await validateMapping(
      describeStub(['UTM_Source__c', 'Monthly_Revenue__c', 'Time_In_Business__c', 'State'], [
        'Amount',
        'csbs__Funded_Amount__c',
        'csbs__Decline_Reason__c',
        'csbs__State__c',
        'csbs__Underwriting_Date_Time__c',
        'csbs__Approved_Date_Time__c',
        'Offer_Received_Date_Time__c',
        'csbs__Funded_Date_Time__c',
        'csbs__Declined_Date_Time__c',
        'Contract_Requested_Date_Time__c',
      ]),
      SPARTAN,
    );
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([
      'Lead.GCLID__c (click ID for google_ads)',
      'Lead.MSCLKID__c (click ID for microsoft_ads)',
    ]);
  });

  it('treats missing UTM and secondary revenue fields as non-blocking', async () => {
    // A missing UTM field costs one slice of the channel breakdown; a missing
    // annual-revenue field costs nothing while the monthly one is present.
    // Neither is the same severity as a missing click ID or stage timestamp.
    const result = await validateMapping(
      describeStub(['GCLID__c', 'MSCLKID__c', 'Monthly_Revenue__c', 'Time_In_Business__c', 'State'], [
        'Amount',
        'csbs__Funded_Amount__c',
        'csbs__Decline_Reason__c',
        'csbs__State__c',
        'csbs__Underwriting_Date_Time__c',
        'csbs__Approved_Date_Time__c',
        'Offer_Received_Date_Time__c',
        'csbs__Funded_Date_Time__c',
        'csbs__Declined_Date_Time__c',
        'Contract_Requested_Date_Time__c',
      ]),
      SPARTAN,
    );
    expect(result.ok).toBe(false);
    expect(result.blocking).toEqual([]);
    expect(result.issues.map((i) => i.field).sort()).toEqual([
      'Annual_Revenue__c',
      'UTM_Source__c',
    ]);
  });
});
