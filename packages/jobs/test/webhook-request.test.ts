import { describe, expect, it } from 'vitest';
import { credentialMatches, describeRequest } from '../src/aloware/webhook-request';

const SECRET = 's3cret-token-0123456789abcdef';
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('credentialMatches', () => {
  it('takes the Zap’s Bearer header, as it always has', () => {
    expect(credentialMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('takes the scheme in any case and the header with stray whitespace', () => {
    expect(credentialMatches(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(credentialMatches(`  BEARER   ${SECRET}  `, SECRET)).toBe(true);
  });

  it('takes Basic with the secret as the password, whatever the user name', () => {
    expect(credentialMatches(basic('aloware', SECRET), SECRET)).toBe(true);
    expect(credentialMatches(basic('', SECRET), SECRET)).toBe(true);
  });

  it('takes Basic with the secret as a lone user name', () => {
    expect(credentialMatches(basic(SECRET, ''), SECRET)).toBe(true);
  });

  it('refuses everything that does not carry the whole secret', () => {
    expect(credentialMatches(null, SECRET)).toBe(false);
    expect(credentialMatches('', SECRET)).toBe(false);
    expect(credentialMatches(SECRET, SECRET)).toBe(false); // no scheme
    expect(credentialMatches(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(credentialMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(credentialMatches(`Bearer Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(credentialMatches(basic('aloware', 'wrong'), SECRET)).toBe(false);
    expect(credentialMatches(basic(SECRET, 'something'), SECRET)).toBe(false);
    expect(credentialMatches(`Token ${SECRET}`, SECRET)).toBe(false);
  });

  it('refuses closed when no secret is configured', () => {
    expect(credentialMatches('Bearer ', '')).toBe(false);
    expect(credentialMatches(`Bearer ${SECRET}`, null)).toBe(false);
  });
});

describe('describeRequest', () => {
  const body = {
    event: 'OutboundPhoneCall-DispositionCompleted',
    body: {
      id: '54363660',
      type: '1',
      direction: '2',
      current_status: 'completed',
      disposition_status: 'completed',
      lead_number: '+15415550123',
      notes: 'Merchant asked for a callback',
      created_at: '2026-10-06 14:22:28',
      contact: { first_name: 'Jane', email: 'jane@example.com', phone_number: '+15415550123' },
    },
  };
  const headers: [string, string][] = [
    ['Authorization', `Basic ${Buffer.from(`aloware:${SECRET}x`).toString('base64')}`],
    ['User-Agent', 'GuzzleHttp/7'],
    ['Content-Type', 'application/json'],
    ['X-Forwarded-For', '203.0.113.9'],
    ['Cookie', 'session=abc'],
  ];
  const describe_ = () =>
    describeRequest({
      headers,
      url: 'https://zeeraa.cloud/api/webhooks/aloware/spartan?token=abc',
      body,
      json: true,
      secret: SECRET,
      now: new Date('2026-10-06T14:30:00Z'),
    });

  it('says what was sent: header names, the credential’s shape, the field paths', () => {
    const d = describe_();
    expect(d.headerNames).toEqual(['authorization', 'content-type', 'cookie', 'user-agent', 'x-forwarded-for']);
    expect(d.queryNames).toEqual(['token']);
    expect(d.userAgent).toBe('GuzzleHttp/7');
    expect(d.auth).toMatchObject({ present: true, scheme: 'basic', basicMatches: false, bearerMatches: false });
    expect(d.fields).toContain('body.lead_number');
    expect(d.fields).toContain('body.contact.email');
    expect(d.values).toMatchObject({
      event: 'OutboundPhoneCall-DispositionCompleted',
      'body.type': '1',
      'body.direction': '2',
      'body.current_status': 'completed',
      'body.created_at (shape)': 'nnnn-nn-nn nn:nn:nn',
    });
  });

  it('carries no personal value, no credential and no address', () => {
    const text = JSON.stringify(describe_());
    for (const leak of [
      '5415550123',
      'Jane',
      'jane@example.com',
      'callback',
      '54363660',
      '2026-10-06 14:22:28',
      SECRET,
      Buffer.from(`aloware:${SECRET}x`).toString('base64'),
      '203.0.113.9',
      'session=abc',
      'abc',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('recognises a correct credential in either form without recording it', () => {
    const bearer = describeRequest({
      headers: [['authorization', `Bearer ${SECRET}`]],
      url: 'https://zeeraa.cloud/x',
      body: null,
      json: false,
      secret: SECRET,
    });
    expect(bearer.auth).toMatchObject({ scheme: 'bearer', bearerMatches: true, credentialLength: SECRET.length });
    expect(JSON.stringify(bearer)).not.toContain(SECRET);
  });

  it('describes a post with no credential and a body that is not JSON', () => {
    const d = describeRequest({
      headers: [['content-type', 'application/x-www-form-urlencoded']],
      url: 'https://zeeraa.cloud/x',
      body: null,
      json: false,
      secret: SECRET,
    });
    expect(d.auth).toMatchObject({ present: false, scheme: null });
    expect(d.json).toBe(false);
    expect(d.fields).toEqual([]);
  });

  it('stays bounded however large the body', () => {
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const d = describeRequest({ headers: [], url: 'https://zeeraa.cloud/x', body: wide, json: true, secret: SECRET });
    expect(d.fields.length).toBeLessThanOrEqual(300);
  });
});
