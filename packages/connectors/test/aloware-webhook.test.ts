import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALOWARE_MAPPING,
  normalizeWebhookCall,
  type AlowareMapping,
} from '../src/aloware/calls';

/**
 * The Zapier "Call Disposed" payload, from a real post of 22 September 2026.
 *
 * Trimmed to the fields the reader touches, with the nesting kept — `User` is
 * an object, and the agent's name is only reachable through it. Every value is
 * as it arrived: `Type` and `Direction` are numbers, `Talk Time` and `Duration`
 * are numbers, `Created At` is a bare wall clock with no offset.
 *
 * It is an SMS event on a leg that was still ringing, which is what makes it
 * the right fixture: it is the thing that must never be ingested.
 */
const POST: Record<string, unknown> = {
  ID: 985097163,
  Event: 'OutboundSMS-DispositionCompleted',
  'Created At': '2026-09-22 19:47:42',
  'Current Status': 'ringing',
  'Disposition Status': 'in-progress',
  Type: 1,
  Direction: 2,
  'Talk Time': 0,
  Duration: 0,
  'Hold Time': 0,
  'Wait Time': 0,
  'Contact Id': 169745494,
  'Lead Number': '+15414103043',
  'Incoming Number': '+19714057798',
  'Destination Number': 'client:agent123260',
  'Owner Id': 123260,
  'User Id': 123260,
  User: { ID: 123260, Name: 'Oscar Huamani', 'Full Name': 'Oscar Huamani' },
  Campaign: { ID: 65345, Name: 'Spartan capital' },
  Contact: { ID: 169745494, 'Phone Number': '+15414103043' },
};

const TZ = 'America/New_York';
/** A finished outbound call, same shape, differing only where it must. */
const completed = (over: Record<string, unknown> = {}) => ({
  ...POST,
  Event: 'OutboundCall-DispositionCompleted',
  'Current Status': 'completed',
  'Disposition Status': 'completed',
  'Talk Time': 95,
  Duration: 130,
  ...over,
});

describe('the SMS-while-ringing post, which is what prompted this', () => {
  it('is rejected for being an SMS event, and names the event', () => {
    const r = normalizeWebhookCall(POST, DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('not a call event');
    expect((r as { type?: string }).type).toBe('OutboundSMS-DispositionCompleted');
  });

  it('is rejected for being unfinished even once the event is allowed', () => {
    // Both gates are independent on purpose: an event named for a completed
    // disposition can still describe a leg that is ringing, which is exactly
    // what this payload does.
    const r = normalizeWebhookCall(
      { ...POST, Event: 'OutboundCall-DispositionCompleted' },
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('call not finished');
    expect((r as { type?: string }).type).toBe('ringing');
  });
});

describe('a finished call', () => {
  it('reads every field the export used to supply', () => {
    const r = normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).not.toBeNull();
    expect(r.row!.externalId).toBe('985097163');
    expect(r.row!.talkTimeSeconds).toBe(95);
    expect(r.row!.durationSeconds).toBe(130);
    expect(r.row!.contactExternalId).toBe('169745494');
    // Reached through the nested `User` object by dotted path.
    expect(r.row!.agentName).toBe('Oscar Huamani');
    expect(r.row!.contactKey).toBe('5414103043');
  });

  it('reads the numeric direction code, which used to come out unknown', () => {
    expect(normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ).row!.direction).toBe(
      'outbound',
    );
    expect(
      normalizeWebhookCall(completed({ Direction: 1 }), DEFAULT_ALOWARE_MAPPING, TZ).row!.direction,
    ).toBe('inbound');
  });

  it('reads the bare wall clock in the tenant zone, not as UTC', () => {
    // 19:47:42 in New York is 23:47:42Z. Read as UTC it would be four hours
    // early, which is the error that made speed to lead look like neglect.
    const r = normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row!.occurredAt.toISOString()).toBe('2026-09-22T23:47:42.000Z');
  });

  it('classifies talk time against the threshold, as the export does', () => {
    expect(normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ).row!.outcome).toBe(
      'connected',
    );
    const brief = normalizeWebhookCall(
      completed({ 'Talk Time': 4 }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(brief.row!.outcome).toBe('attempted');
    expect(brief.row!.answeredBriefly).toBe(true);
  });
});

describe('the gates fail closed', () => {
  it('rejects everything when the tenant has no webhook profile', () => {
    const noProfile: AlowareMapping = { ...DEFAULT_ALOWARE_MAPPING, webhook: undefined };
    const r = normalizeWebhookCall(completed(), noProfile, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toContain('no webhook mapping');
  });

  it('rejects an event nobody has listed rather than guessing from its name', () => {
    // A deny-list of SMS would let this through and count a voicemail drop as
    // a call; an allow-list reports it and ingests nothing.
    const r = normalizeWebhookCall(
      completed({ Event: 'OutboundVoicemail-DispositionCompleted' }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).toBeNull();
    expect((r as { type?: string }).type).toBe('OutboundVoicemail-DispositionCompleted');
  });

  it('rejects a blank event and a blank status by name', () => {
    const noEvent = normalizeWebhookCall({ ...completed(), Event: '' }, DEFAULT_ALOWARE_MAPPING, TZ);
    expect((noEvent as { type?: string }).type).toBe('(blank)');
    const noStatus = normalizeWebhookCall(
      { ...completed(), 'Current Status': '' },
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect((noStatus as { type?: string }).type).toBe('(blank)');
  });

  it('still refuses a post with no communication id', () => {
    const r = normalizeWebhookCall(completed({ ID: '' }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('no Communication ID');
  });
});
