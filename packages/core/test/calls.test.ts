import { describe, expect, it } from 'vitest';
import {
  attemptsPerLead,
  callVolume,
  formatDuration,
  speedToLead,
} from '../src/calls';

describe('callVolume', () => {
  it('keeps abandoned out of both other buckets', () => {
    // Spartan's shape: 2,002 of 28,863 abandoned. An abandoned call is not a
    // conversation and not an agent's attempt at one.
    const v = callVolume({ connected: 14_000, attempted: 12_861, abandoned: 2_002 });
    expect(v.total).toBe(28_863);
    expect(v.handled).toBe(26_861);
    expect(v.connected + v.attempted).toBe(v.handled);
  });

  it('excludes abandoned from the connect rate denominator', () => {
    // The desk cannot connect a call the caller hung up. Counting those
    // against it measures the client's marketing, not the desk.
    const v = callVolume({ connected: 50, attempted: 50, abandoned: 100 });
    expect(v.connectRate).toBe(0.5);
  });

  it('has no connect rate when nothing was handled', () => {
    // A day of nothing but abandoned calls is not a 0% connect rate.
    const v = callVolume({ connected: 0, attempted: 0, abandoned: 7 });
    expect(v.connectRate).toBeNull();
    expect(v.total).toBe(7);
  });

  it('refuses to be moved by a negative or fractional count', () => {
    const v = callVolume({ connected: -3, attempted: 10.9, abandoned: -1 });
    expect(v.connected).toBe(0);
    expect(v.attempted).toBe(10);
    expect(v.abandoned).toBe(0);
    expect(v.connectRate).toBe(0);
  });
});

describe('speedToLead', () => {
  const rows = [11, 45, 200, 400, 1_000, 5_000, 80_000].map((seconds) => ({ seconds }));

  it('reports the median, the mean and p90 without choosing for the reader', () => {
    const s = speedToLead(rows, 0);
    expect(s.called).toBe(7);
    expect(s.medianSeconds).toBe(400);
    // The mean is dragged up an order of magnitude by one late call, which is
    // exactly why the median is the headline.
    expect(s.meanSeconds).toBeCloseTo(12_379.43, 1);
    expect(s.p90Seconds).toBe(80_000);
  });

  it('takes an observed value as the quantile, never an interpolation', () => {
    // A median of 214.5s when no call took 214.5s is a figure nobody can go
    // and look at in the dialer.
    const s = speedToLead([{ seconds: 200 }, { seconds: 229 }], 0);
    expect([200, 229]).toContain(s.medianSeconds);
  });

  it('carries the uncalled population rather than leaving it to a caption', () => {
    // A four-minute median over 12% of leads is a different claim from a
    // four-minute median.
    const s = speedToLead(rows, 93);
    expect(s.notCalled).toBe(93);
    expect(s.coverage).toBeCloseTo(7 / 100, 4);
  });

  it('measures the five-minute bar against called leads, not all leads', () => {
    const s = speedToLead(rows, 1_000);
    // 11s, 45s and 200s are inside five minutes: three of seven called.
    expect(s.withinFiveMinutes).toBe(3);
    expect(s.withinFiveMinutesShare).toBeCloseTo(3 / 7, 4);
  });

  it('drops a call stamped before its lead instead of scoring it as instant', () => {
    // A merchant who rings in has the lead created mid-conversation. Real
    // event, genuine zero — but not a response to the lead, and averaging it
    // as zero flatters the desk with calls made before it had anything to call.
    const s = speedToLead([{ seconds: -400 }, { seconds: 200 }], 0);
    expect(s.called).toBe(1);
    expect(s.medianSeconds).toBe(200);
  });

  it('is null rather than zero when nobody was called', () => {
    const s = speedToLead([], 500);
    expect(s.medianSeconds).toBeNull();
    expect(s.p90Seconds).toBeNull();
    expect(s.withinFiveMinutesShare).toBeNull();
    // Coverage is a real zero here: there are leads, and none were called.
    expect(s.coverage).toBe(0);
  });

  it('has no coverage at all with no leads either way', () => {
    expect(speedToLead([], 0).coverage).toBeNull();
  });
});

describe('attemptsPerLead', () => {
  const rows = [
    { attempts: 1, connected: true, connectedOnFirst: true },
    { attempts: 1, connected: true, connectedOnFirst: true },
    { attempts: 4, connected: true, connectedOnFirst: false },
    { attempts: 6, connected: false, connectedOnFirst: false },
    { attempts: 2, connected: false, connectedOnFirst: false },
    // Never called: outside the denominator entirely.
    { attempts: 0, connected: false, connectedOnFirst: false },
  ];

  it('divides attempts by leads called, not by all leads', () => {
    const a = attemptsPerLead(rows);
    expect(a.leadsCalled).toBe(5);
    expect(a.attempts).toBe(14);
    expect(a.mean).toBeCloseTo(2.8, 4);
    expect(a.median).toBe(2);
  });

  it('counts leads reached on the first attempt', () => {
    expect(attemptsPerLead(rows).connectedFirstAttempt).toBe(2);
  });

  it('counts effort spent on numbers that never answered', () => {
    // Two calls and no connect, six calls and no connect: the number a desk
    // manager actually asks for.
    expect(attemptsPerLead(rows).chasedNeverConnected).toBe(2);
  });

  it('is null rather than zero when no lead was called', () => {
    const a = attemptsPerLead([{ attempts: 0, connected: false, connectedOnFirst: false }]);
    expect(a.leadsCalled).toBe(0);
    expect(a.mean).toBeNull();
    expect(a.median).toBeNull();
  });
});

describe('formatDuration', () => {
  it('changes unit with magnitude, because the column spans four orders', () => {
    expect(formatDuration(11)).toBe('11s');
    expect(formatDuration(95)).toBe('1m 35s');
    expect(formatDuration(5_400)).toBe('1h 30m');
    expect(formatDuration(180_000)).toBe('2d 2h');
  });

  it('renders an absent duration as an em dash, never as zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});
