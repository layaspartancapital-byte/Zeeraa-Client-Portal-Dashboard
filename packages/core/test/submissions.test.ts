import { describe, expect, it } from 'vitest';
import {
  AWAITING_LENDER_ANSWER,
  pendingState,
  rankReasonCitations,
  reasonCoverageByPeriod,
  submissionOfferRate,
} from '../src/submissions';

describe('submissionOfferRate', () => {
  it('divides offers by decisions, not by submissions', () => {
    // Spartan's live figures. 131/1427 would be 9.2% and would be describing
    // how much of the pipeline has been answered, not how often a lender says
    // yes.
    const r = submissionOfferRate({ offered: 131, declined: 590, undecided: 706 });
    expect(r.decided).toBe(721);
    expect(r.rate).toBeCloseTo(0.1817, 4);
    expect(r.undecided).toBe(706);
    expect(r.coverage).toBeCloseTo(721 / 1427, 4);
  });

  it('is null rather than zero when nothing has been decided', () => {
    // A window where every submission is still open is not a window where
    // every lender declined.
    const r = submissionOfferRate({ offered: 0, declined: 0, undecided: 40 });
    expect(r.rate).toBeNull();
    expect(r.decided).toBe(0);
    expect(r.undecided).toBe(40);
  });

  it('is null with no submissions at all', () => {
    const r = submissionOfferRate({ offered: 0, declined: 0, undecided: 0 });
    expect(r.rate).toBeNull();
    expect(r.coverage).toBeNull();
  });

  it('reaches 1 only when every decision was an offer', () => {
    const r = submissionOfferRate({ offered: 7, declined: 0, undecided: 3 });
    expect(r.rate).toBe(1);
    // And it still says three lenders have not answered.
    expect(r.undecided).toBe(3);
  });

  it('never exceeds 1, because the numerator is part of the denominator', () => {
    for (const tally of [
      { offered: 1, declined: 0, undecided: 0 },
      { offered: 131, declined: 590, undecided: 706 },
      { offered: 50, declined: 1, undecided: 900 },
    ]) {
      expect(submissionOfferRate(tally).rate!).toBeLessThanOrEqual(1);
    }
  });

  it('refuses to be moved by a negative or fractional count', () => {
    // Counts come from SQL and should be whole and non-negative; if one is not,
    // the metric must not silently produce a rate above 1 or below 0.
    const r = submissionOfferRate({ offered: -5, declined: 10.7, undecided: -1 });
    expect(r.offered).toBe(0);
    expect(r.declined).toBe(10);
    expect(r.undecided).toBe(0);
    expect(r.rate).toBe(0);
  });
});

describe('reasonCoverageByPeriod', () => {
  it('reports a share per period and never one across them', () => {
    // The real adoption curve. An all-time 20.5% would describe no month in it.
    const rows = reasonCoverageByPeriod({
      '2026-09': { declined: 308, withReason: 94 },
      '2026-06': { declined: 2, withReason: 0 },
      '2026-08': { declined: 254, withReason: 23 },
      '2026-07': { declined: 26, withReason: 4 },
    });
    expect(rows.map((r) => r.period)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    expect(rows.at(-1)?.share).toBeCloseTo(0.3052, 4);
    expect(rows[0]?.share).toBe(0);
  });

  it('gives a period with no declines no share at all', () => {
    const [row] = reasonCoverageByPeriod({ '2026-05': { declined: 0, withReason: 0 } });
    expect(row?.share).toBeNull();
  });
});

describe('rankReasonCitations', () => {
  it('counts citations and says how many declines they came from', () => {
    const { reasons, total, declinesWithReason } = rankReasonCitations([
      { reasons: ['Insufficient Revenue / Cash Flow', 'MCA Stacking / Recent Advance'] },
      { reasons: ['Insufficient Revenue / Cash Flow'] },
      { reasons: null },
      { reasons: [] },
    ]);
    // Three citations from two declines: a multipicklist means the citations
    // sum above the declines, so this can never be rendered as a share.
    expect(total).toBe(3);
    expect(declinesWithReason).toBe(2);
    expect(reasons).toEqual([
      { reason: 'Insufficient Revenue / Cash Flow', citations: 2 },
      { reason: 'MCA Stacking / Recent Advance', citations: 1 },
    ]);
  });

  it('counts one lender citing the same reason twice as once', () => {
    const { reasons, total } = rankReasonCitations([{ reasons: ['Bankruptcy', 'Bankruptcy'] }]);
    expect(reasons).toEqual([{ reason: 'Bankruptcy', citations: 1 }]);
    expect(total).toBe(1);
  });

  it('ignores blank entries rather than ranking an empty reason', () => {
    const { reasons, declinesWithReason } = rankReasonCitations([
      { reasons: ['', '  '] },
      { reasons: ['Bankruptcy'] },
    ]);
    expect(reasons).toEqual([{ reason: 'Bankruptcy', citations: 1 }]);
    expect(declinesWithReason).toBe(1);
  });

  it('breaks a tie by name so the order is stable between renders', () => {
    const { reasons } = rankReasonCitations([{ reasons: ['Bankruptcy'] }, { reasons: ['Alpha'] }]);
    expect(reasons.map((r) => r.reason)).toEqual(['Alpha', 'Bankruptcy']);
  });
});

describe('pendingState', () => {
  it('waits only while the deal is open', () => {
    expect(pendingState(AWAITING_LENDER_ANSWER, false)).toBe('waiting');
    // Not yet known to be closed reads as waiting: the old behaviour, never less.
    expect(pendingState(AWAITING_LENDER_ANSWER, null)).toBe('waiting');
    expect(pendingState(AWAITING_LENDER_ANSWER, true)).toBe('closed_unanswered');
  });

  it('keeps a submission that never went through apart from both', () => {
    expect(pendingState('submission did not complete', false)).toBe('not_completed');
    expect(pendingState('no status recorded', true)).toBe('not_completed');
    expect(pendingState(null, null)).toBe('not_completed');
  });
});
