import { describe, expect, it } from 'vitest';
import { declineReasonBreakdown, describeCoverage } from '../src/decline-reasons';

/** Spartan's real coverage: a reason on 16.4% of closed-lost opportunities. */
function spartanShaped(total = 1000, recorded = 164) {
  return Array.from({ length: total }, (_, i) => ({
    reason: i < recorded ? (i % 2 === 0 ? 'Time in business' : 'Monthly revenue') : null,
  }));
}

describe('decline reasons', () => {
  it('never renormalises over the records that happen to have a value', () => {
    const b = declineReasonBreakdown(spartanShaped());
    // The trap: 82 of 164 recorded is 50%, and a renormalised chart would say
    // "half of declines are time in business". Over the real total it is 8.2%.
    expect(b.reasons[0]).toEqual({ reason: 'Monthly revenue', count: 82, share: 0.082 });
    expect(b.reasons[1]).toEqual({ reason: 'Time in business', count: 82, share: 0.082 });
  });

  it('makes not-recorded a category, and the shares sum to one', () => {
    const b = declineReasonBreakdown(spartanShaped());
    expect(b.notRecorded).toBe(836);
    expect(b.notRecordedShare).toBeCloseTo(0.836, 10);
    const sum = b.reasons.reduce((t, r) => t + r.share, 0) + b.notRecordedShare;
    expect(sum).toBeCloseTo(1, 10);
  });

  it('marks 16.4% coverage as sparse', () => {
    expect(declineReasonBreakdown(spartanShaped()).sparse).toBe(true);
  });

  it('stops calling it sparse once most declines carry a reason', () => {
    expect(declineReasonBreakdown(spartanShaped(1000, 800)).sparse).toBe(false);
  });

  it('treats whitespace as not recorded', () => {
    const b = declineReasonBreakdown([{ reason: '   ' }, { reason: undefined }, { reason: 'Fraud' }]);
    expect(b.recorded).toBe(1);
    expect(b.notRecorded).toBe(2);
  });

  it('orders by count, then by name for stability', () => {
    const b = declineReasonBreakdown([
      { reason: 'B' },
      { reason: 'A' },
      { reason: 'C' },
      { reason: 'C' },
    ]);
    expect(b.reasons.map((r) => r.reason)).toEqual(['C', 'A', 'B']);
  });

  it('does not divide by zero on an empty period', () => {
    const b = declineReasonBreakdown([]);
    expect(b).toMatchObject({ total: 0, notRecordedShare: 0, sparse: true });
    expect(describeCoverage(b)).toMatch(/no closed-lost/i);
  });

  it('describes the gap in words, with the count', () => {
    expect(describeCoverage(declineReasonBreakdown(spartanShaped()))).toBe(
      'A reason is recorded on 16.4% of the 1000 declined deals in this period. ' +
        'The remaining 836 are shown as not recorded rather than left out.',
    );
  });
});
