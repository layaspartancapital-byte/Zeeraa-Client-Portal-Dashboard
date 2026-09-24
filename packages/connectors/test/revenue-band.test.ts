import { describe, expect, it } from 'vitest';
import { readRevenueBand, type SalesforceFieldMapping } from '../src';

const mapping = (edges?: number[]) =>
  ({
    lead: {
      revenueBands: [
        { field: 'Average_Monthly_Revenue_Text2__c', period: 'monthly' },
        { field: 'Monthly_Revenue_Text__c', period: 'monthly' },
      ],
      revenueBandEdges: edges,
    },
  }) as unknown as SalesforceFieldMapping;
const EDGES = [10_000, 20_000, 50_000, 100_000];

describe('readRevenueBand', () => {
  it('stores the band the first placeable answer falls in', () => {
    expect(readRevenueBand({ Average_Monthly_Revenue_Text2__c: '$10,000 - $20,000' }, mapping(EDGES))).toBe('10000-20000');
  });

  it('lets a later field answer when an earlier one spans two bands', () => {
    expect(
      readRevenueBand({ Average_Monthly_Revenue_Text2__c: '< $15,000', Monthly_Revenue_Text__c: '25000' }, mapping(EDGES)),
    ).toBe('20000-50000');
  });

  it('keeps an answer that fits no band as unplaced, and New Business as itself', () => {
    expect(readRevenueBand({ Average_Monthly_Revenue_Text2__c: '< $15,000' }, mapping(EDGES))).toBe('unplaced:spans_bands');
    expect(readRevenueBand({ Average_Monthly_Revenue_Text2__c: 'New Business' }, mapping(EDGES))).toBe('categorical:New Business');
  });

  it('stores nothing without an answer or without edges', () => {
    expect(readRevenueBand({}, mapping(EDGES))).toBeNull();
    expect(readRevenueBand({ Average_Monthly_Revenue_Text2__c: '$10,000 - $20,000' }, mapping())).toBeNull();
  });
});
