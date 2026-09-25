import { describe, expect, it } from 'vitest';
import { canSyncNow, isManualSyncThrottled, manualSyncVerdict, MANUAL_SYNC_INTERVAL_MINUTES, ROLES } from '../src';

const at = (m: number, s = 0) => new Date(Date.UTC(2026, 8, 25, 14, m, s));

describe('manual sync throttle', () => {
  it('allows the first sync', () => {
    expect(manualSyncVerdict(null, at(0))).toEqual({ allowed: true });
  });

  it('refuses a second within five minutes, and says when and how long', () => {
    const v = manualSyncVerdict(at(0), at(2, 10));
    expect(v).toMatchObject({ allowed: false, nextAt: at(MANUAL_SYNC_INTERVAL_MINUTES) });
    expect(v.allowed === false && v.message).toBe('Synced 2 min ago, next available in 3 min');
  });

  it('says "just now" in the first minute and never "in 0 min" at the end', () => {
    const first = manualSyncVerdict(at(0), at(0, 20));
    expect(first.allowed === false && first.message).toBe('Synced just now, next available in 5 min');
    const last = manualSyncVerdict(at(0), at(4, 59));
    expect(last.allowed === false && last.message).toBe('Synced 4 min ago, next available in 1 min');
  });

  it('allows again at exactly five minutes', () => {
    expect(manualSyncVerdict(at(0), at(5)).allowed).toBe(true);
  });

  it('treats a start stamped in the future as just now, not as allowed', () => {
    const v = manualSyncVerdict(at(3), at(2));
    expect(v.allowed === false && v.message).toBe('Synced just now, next available in 6 min');
  });

  it('throttles every role but a Zeeraa admin', () => {
    expect(ROLES.filter(isManualSyncThrottled)).toEqual(['zeeraa_member', 'client_admin', 'client_viewer']);
  });

  it('is open to every role', () => {
    for (const role of ROLES) expect(canSyncNow(role)).toBe(true);
  });
});
