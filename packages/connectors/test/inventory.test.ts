/**
 * The inventory's judgement, tested against a stub.
 *
 * This proves the report is assembled and ranked correctly. It proves nothing
 * about which fields Spartan's org actually has — that is what running it
 * against the org is for.
 */
import { describe, expect, it } from 'vitest';
import type { SalesforceClient } from '../src/salesforce/client';
import { formatInventory, probeLeadFieldInventory } from '../src/salesforce/inventory';

function field(name: string, type: string, label = name, custom = true) {
  return { name, label, type, custom };
}

function stub(fields: ReturnType<typeof field>[], counts: Record<string, number>, total = 1000) {
  return {
    describe: async () => ({ name: 'Lead', fields }),
    query: async (soql: string) => {
      if (soql.includes('COUNT(Id) total')) {
        const row: Record<string, number> = { total };
        // Mirror the aliasing the probe uses: c0, c1, … in SELECT order.
        const aliases = [...soql.matchAll(/COUNT\((\w+)\) (c\d+)/g)];
        for (const [, fieldName, alias] of aliases) row[alias!] = counts[fieldName!] ?? 0;
        return [row];
      }
      // The sampled path for long text areas.
      return Array.from({ length: 100 }, (_, i) => ({
        Id: `00Q${i}`,
        Landing_Page__c: i < (counts.Landing_Page__c ?? 0) ? 'https://example.test/a' : null,
      }));
    },
  } as unknown as SalesforceClient;
}

describe('the field inventory', () => {
  it('ranks candidates by how often they are populated', async () => {
    const inventories = await probeLeadFieldInventory(
      stub(
        [
          field('Monthly_Revenue__c', 'currency'),
          field('Monthly_Gross_Sales__c', 'currency'),
        ],
        { Monthly_Revenue__c: 200, Monthly_Gross_Sales__c: 900 },
      ),
    );
    const revenue = inventories.find((i) => i.concept === 'monthly revenue')!;
    expect(revenue.candidates.map((c) => c.apiName)).toEqual([
      'Monthly_Gross_Sales__c',
      'Monthly_Revenue__c',
    ]);
    expect(revenue.recommended?.apiName).toBe('Monthly_Gross_Sales__c');
    expect(revenue.recommended?.rate).toBe(0.9);
  });

  it('flags a concept whose best field is below half', async () => {
    const inventories = await probeLeadFieldInventory(
      stub([field('UTM_Source__c', 'string')], { UTM_Source__c: 310 }),
    );
    const utm = inventories.find((i) => i.concept === 'utm source')!;
    expect(utm.belowThreshold).toBe(true);
    expect(formatInventory([utm])).toMatch(/LOW/);
  });

  it('does not flag a well-populated field', async () => {
    const inventories = await probeLeadFieldInventory(
      stub([field('UTM_Source__c', 'string')], { UTM_Source__c: 940 }),
    );
    expect(inventories.find((i) => i.concept === 'utm source')!.belowThreshold).toBe(false);
  });

  it('reports a concept with no candidate as absent rather than as zero', async () => {
    // Absent and empty are different findings with different remedies.
    const inventories = await probeLeadFieldInventory(stub([field('Email', 'email')], {}));
    const landing = inventories.find((i) => i.concept === 'landing page')!;
    expect(landing.absent).toBe(true);
    expect(landing.recommended).toBeNull();
    expect(formatInventory([landing])).toMatch(/ABSENT/);
  });

  it('picks up standard fields that do not match the custom-field patterns', async () => {
    const inventories = await probeLeadFieldInventory(
      stub(
        [field('AnnualRevenue', 'currency', 'Annual Revenue', false), field('Industry', 'picklist', 'Industry', false)],
        { AnnualRevenue: 700, Industry: 800 },
      ),
    );
    expect(inventories.find((i) => i.concept === 'annual revenue')!.recommended?.apiName).toBe(
      'AnnualRevenue',
    );
    expect(inventories.find((i) => i.concept === 'industry')!.recommended?.apiName).toBe('Industry');
  });

  it('labels a sampled count rather than passing it off as exact', async () => {
    // Long text areas cannot be aggregated in SOQL, so their rate comes from a
    // sample and says so.
    const inventories = await probeLeadFieldInventory(
      stub([field('Landing_Page__c', 'textarea')], { Landing_Page__c: 60 }),
    );
    const landing = inventories.find((i) => i.concept === 'landing page')!;
    expect(landing.recommended?.note).toMatch(/sampled/i);
    expect(landing.recommended?.total).toBe(100);
  });

  it('separates a date-based time in business from a numeric one', async () => {
    const inventories = await probeLeadFieldInventory(
      stub(
        [field('Time_In_Business__c', 'double'), field('Date_Established__c', 'date')],
        { Time_In_Business__c: 400, Date_Established__c: 850 },
      ),
    );
    const tib = inventories.find((i) => i.concept === 'time in business')!;
    expect(tib.candidates).toHaveLength(2);
    expect(tib.recommended?.apiName).toBe('Date_Established__c');
    expect(tib.recommended?.type).toBe('date');
  });

  it('reports a rate of null rather than zero for an empty org', async () => {
    const inventories = await probeLeadFieldInventory(
      stub([field('Monthly_Revenue__c', 'currency')], {}, 0),
    );
    expect(inventories.find((i) => i.concept === 'monthly revenue')!.recommended?.rate).toBeNull();
  });
});
