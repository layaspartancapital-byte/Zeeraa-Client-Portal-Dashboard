import { describe, expect, it } from 'vitest';
import { formatPhone, phoneKey, readPhone } from '../src/phone';

describe('readPhone', () => {
  it('reduces every rendering of one number to one key', () => {
    // The dialer writes E.164, the CRM writes whatever the form captured.
    // These are the same merchant and must join.
    for (const raw of [
      '+13125551234',
      '13125551234',
      '3125551234',
      '(312) 555-1234',
      '312-555-1234',
      '312.555.1234',
      ' 312 555 1234 ',
      '+1 (312) 555-1234',
    ]) {
      expect(phoneKey(raw), raw).toBe('3125551234');
    }
  });

  it('drops an extension rather than keying on it', () => {
    // Otherwise one number becomes several keys and one lead's calls split.
    expect(phoneKey('312-555-1234 x204')).toBe('3125551234');
    expect(phoneKey('3125551234 ext. 9')).toBe('3125551234');
    expect(phoneKey('3125551234 extension 9')).toBe('3125551234');
  });

  it('refuses a number that is too short instead of matching a prefix', () => {
    // A partial number matching a full one is the failure mode that attributes
    // one merchant's calls to another's lead.
    const r = readPhone('555-0100');
    expect(r.key).toBeNull();
    expect(r.key === null && r.rejected).toBe('too_short');
  });

  it('refuses an international number rather than cutting it down', () => {
    const r = readPhone('+44 20 7946 0958');
    expect(r.key).toBeNull();
    expect(r.key === null && r.rejected).toBe('not_north_american');
  });

  it('refuses a country code other than 1 at eleven digits', () => {
    const r = readPhone('+33125551234');
    expect(r.key).toBeNull();
  });

  it('refuses a placeholder that would collapse many leads onto one key', () => {
    // 0000000000 and 1111111111 appear in form data as skipped fields. Keyed,
    // they would make every one of those leads the same merchant.
    for (const raw of ['0000000000', '1111111111', '(000) 000-0000']) {
      expect(readPhone(raw).key, raw).toBeNull();
    }
  });

  it('refuses an exchange starting with 0 or 1', () => {
    expect(readPhone('3121551234').key).toBeNull();
    expect(readPhone('3120551234').key).toBeNull();
  });

  it('reports an empty field as empty rather than as malformed', () => {
    // Different conversation with the client: a blank field is a form that did
    // not ask, a malformed one is a form that did not validate.
    for (const raw of [null, undefined, '', '   ', '--']) {
      const r = readPhone(raw);
      expect(r.key).toBeNull();
      expect(r.key === null && r.rejected).toBe('empty');
    }
  });

  it('keeps the raw text alongside the key, for the audit', () => {
    const r = readPhone(' (312) 555-1234 ');
    expect(r.raw).toBe('(312) 555-1234');
  });
});

describe('formatPhone', () => {
  it('renders a key for a human without changing it', () => {
    expect(formatPhone('3125551234')).toBe('(312) 555-1234');
  });

  it('passes anything that is not a key straight through', () => {
    expect(formatPhone('not a number')).toBe('not a number');
  });
});
