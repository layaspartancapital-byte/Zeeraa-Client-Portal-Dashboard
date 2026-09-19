/**
 * The campaign-type breakdown has to answer "how did Performance Max do" even
 * when the answer is "it did not run".
 *
 * Grouping the metrics alone drops a type with no delivery entirely, and a
 * reader cannot tell a missing row from a type the account does not use — which
 * are the two answers they are actually choosing between.
 */
import { describe, expect, it } from 'vitest';
import { mergeTypes } from '../src/lib/platform-types';

const delivered = (key: string | null, spend: string, delivering: number) => ({
  key,
  spend,
  impressions: '1000',
  clicks: '10',
  conversions: '1',
  delivering,
});

describe('mergeTypes', () => {
  it('keeps a configured type that delivered nothing', () => {
    const rows = mergeTypes(
      [delivered('SEARCH', '79692', 10)],
      [
        { key: 'SEARCH', configured: 35 },
        { key: 'PERFORMANCE_MAX', configured: 7 },
        { key: 'DISPLAY', configured: 1 },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(['SEARCH', 'PERFORMANCE_MAX', 'DISPLAY']);

    const pmax = rows.find((r) => r.key === 'PERFORMANCE_MAX')!;
    expect(pmax.spend).toBe(0);
    expect(pmax.delivering).toBe(0);
    expect(pmax.configured).toBe(7);
  });

  it('does not invent a type the account does not have', () => {
    // No VIDEO row, because this account runs no Video campaigns. Showing one
    // at zero would be inventing a figure the platform never reported.
    const rows = mergeTypes([delivered('SEARCH', '100', 1)], [{ key: 'SEARCH', configured: 1 }]);
    expect(rows.map((r) => r.key)).toEqual(['SEARCH']);
  });

  it('keeps account-level delivery that resolves to no campaign', () => {
    // Spend that belongs to the channel and to no campaign is still the
    // channel's spend; dropping it would make the page disagree with the
    // platform's own total.
    const rows = mergeTypes([delivered(null, '500', 0)], [{ key: 'SEARCH', configured: 2 }]);
    expect(rows.map((r) => r.key)).toContain(null);
    expect(rows.find((r) => r.key === null)!.spend).toBe(500);
  });

  it('orders by spend, then by how many campaigns exist', () => {
    const rows = mergeTypes(
      [delivered('DISPLAY', '10', 1), delivered('SEARCH', '900', 4)],
      [
        { key: 'SEARCH', configured: 4 },
        { key: 'DISPLAY', configured: 1 },
        { key: 'VIDEO', configured: 9 },
        { key: 'SHOPPING', configured: 2 },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(['SEARCH', 'DISPLAY', 'VIDEO', 'SHOPPING']);
  });
});
