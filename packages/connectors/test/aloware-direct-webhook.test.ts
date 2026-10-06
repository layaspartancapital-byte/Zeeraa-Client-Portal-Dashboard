import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALOWARE_MAPPING,
  detectAlowareSender,
  normalizeWebhookCall,
  type AlowareMapping,
} from '../src/aloware/calls';

/**
 * Aloware's own webhook, without the Zap.
 *
 * The payload is the documented "outbound call" sample from Aloware's
 * "Using Aloware webhook integration for real-time automation", trimmed to
 * the fields a reader could plausibly touch and with every personal value
 * replaced by a fake. Everything is a string, as documented — including the
 * codes the Zap sends as numbers — and the record sits under `body`.
 */
const NATIVE = {
  body: {
    id: '54363660',
    company_id: '47',
    campaign_id: '2803',
    owner_id: '42',
    user_id: '42',
    incoming_number: '+18186006750',
    contact_id: '6896898',
    lead_number: '+15415550123',
    destination_number: 'client:agent42',
    direction: '2',
    type: '1',
    body: '',
    current_status: 'completed',
    disposition_status: 'completed',
    duration: '44',
    talk_time: '40',
    wait_time: '4',
    notes: '',
    created_at: '2026-10-06 14:22:28',
    updated_at: '2026-10-06 14:23:12',
    contact: {
      id: '6896898',
      phone_number: '+15415550123',
      first_name: 'Test',
      last_name: 'Merchant',
      email: '',
    },
  },
  event: 'OutboundPhoneCall-DispositionCompleted',
};

const native = (body: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
  ...NATIVE,
  ...rest,
  body: { ...NATIVE.body, ...body },
});

const TZ = 'America/New_York';
const M = DEFAULT_ALOWARE_MAPPING;
const read = (record: Record<string, unknown>, mapping: AlowareMapping = M) =>
  normalizeWebhookCall(record, mapping, TZ, mapping.directWebhook);

describe('the native payload, read with the native profile', () => {
  it('reads every field the Zap supplies, under its native name', () => {
    const r = read(NATIVE);
    expect(r.row).not.toBeNull();
    expect(r.row!.externalId).toBe('54363660');
    expect(r.row!.direction).toBe('outbound');
    expect(r.row!.outcome).toBe('connected');
    expect(r.row!.disposition).toBe('completed');
    expect(r.row!.talkTimeSeconds).toBe(40);
    expect(r.row!.durationSeconds).toBe(44);
    // `lead_number`, not `incoming_number` (Aloware's line) or the agent leg.
    expect(r.row!.contactKey).toBe('5415550123');
    expect(r.row!.contactExternalId).toBe('6896898');
    expect(r.row!.agentExternalId).toBe('42');
  });

  it('reads created_at as UTC, as the Zap’s Created At is', () => {
    expect(read(NATIVE).row!.occurredAt.toISOString()).toBe('2026-10-06T14:22:28.000Z');
  });

  it('takes the agent’s name from the tenant’s map, because the post carries only the id', () => {
    expect(read(NATIVE).row!.agentName).toBeNull();
    const mapped = { ...M, agents: { '42': 'Agent Forty-Two' } };
    expect(read(NATIVE, mapped).row!.agentName).toBe('Agent Forty-Two');
  });

  it('classifies a short completed call as an attempt, against the same threshold', () => {
    const r = read(native({ talk_time: '12' }));
    expect(r.row!.outcome).toBe('attempted');
    expect(r.row!.answeredBriefly).toBe(true);
  });

  it('reads an abandoned inbound call', () => {
    const r = read(native({ direction: '1', disposition_status: 'abandoned', talk_time: '0' }));
    expect(r.row!.direction).toBe('inbound');
    expect(r.row!.outcome).toBe('abandoned');
  });
});

describe('the gates are the Zap’s gates', () => {
  it('rejects a text by its type, whatever the event says', () => {
    const r = read(native({ type: '2' }, { event: 'OutboundPhoneCall-DispositionCompleted' }));
    expect(r.row).toBeNull();
    expect(r).toMatchObject({ reason: 'not a call', type: '2' });
  });

  it('rejects a leg still ringing', () => {
    const r = read(native({ current_status: 'ringing', disposition_status: 'in-progress' }));
    expect(r).toMatchObject({ reason: 'call still in flight', type: 'ringing' });
  });

  it('rejects a contact event, which has no call fields at all', () => {
    const r = read({ event: 'Contact-Created', body: { id: '1', phone_number: '+15415550123' } });
    expect(r.row).toBeNull();
    expect(r).toMatchObject({ reason: 'not a call', type: '(blank)' });
  });

  it('refuses a post with no id, which could not be de-duplicated', () => {
    expect(read(native({ id: '' }))).toMatchObject({ reason: 'no Communication ID' });
  });

  it('does not read a native post with the Zap’s names, which is why the profile exists', () => {
    expect(normalizeWebhookCall(NATIVE, M, TZ).row).toBeNull();
  });
});

describe('one call by two senders is one call', () => {
  it('produces the same row from the Zap’s shape and the native one', () => {
    const zap = {
      ID: 54363660,
      Event: 'OutboundSMS-DispositionCompleted',
      'Created At': '2026-10-06 14:22:28',
      'Current Status': 'completed',
      'Disposition Status': 'completed',
      Type: 1,
      Direction: 2,
      'Talk Time': 40,
      Duration: 44,
      'Contact Id': 6896898,
      'Lead Number': '+15415550123',
      'User Id': 42,
    };
    const fromZap = normalizeWebhookCall(zap, M, TZ).row!;
    const fromAloware = read(NATIVE).row!;
    expect(fromAloware).toEqual(fromZap);
  });
});

describe('detectAlowareSender', () => {
  it('knows Aloware by its envelope', () => {
    expect(detectAlowareSender(NATIVE)).toBe('aloware');
  });

  it('knows the Zap by its flat ID, a batch, or its agent', () => {
    expect(detectAlowareSender({ ID: 1, 'Created At': 'x' })).toBe('zapier');
    expect(detectAlowareSender({ data: [] })).toBe('zapier');
    expect(detectAlowareSender([{ ID: 1 }])).toBe('zapier');
    expect(detectAlowareSender(null, 'Zapier')).toBe('zapier');
  });

  it('calls anything else unknown rather than guessing', () => {
    expect(detectAlowareSender({ hello: 'world' })).toBe('unknown');
    expect(detectAlowareSender(null, 'GuzzleHttp/7')).toBe('unknown');
    // An envelope with no event is not Aloware's.
    expect(detectAlowareSender({ body: { id: '1' } })).toBe('unknown');
  });
});
