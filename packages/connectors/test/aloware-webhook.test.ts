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
 * **It is a call still ringing, and `Event` says SMS anyway.** That reading is
 * the correction this file exists to pin: Spartan sends no text messages, and
 * Aloware puts `OutboundSMS-DispositionCompleted` on calls regardless. So the
 * event name is evidence of nothing, the payload is an unfinished leg, and it
 * is the right fixture because it is the thing that must never be ingested.
 */
const POST: Record<string, unknown> = {
  ID: 985097163,
  Event: 'OutboundSMS-DispositionCompleted',
  'Created At': '2026-09-22 19:47:42',
  'Current Status': 'ringing',
  'Current Status 2': 1,
  'Disposition Status': 'in-progress',
  'Disposition Status 2': 1,
  'Customer Leg Status': 2,
  Type: 1,
  Direction: 2,
  'Talk Time': 0,
  Duration: 0,
  'Hold Time': 0,
  'Wait Time': 0,
  'Has Recording': false,
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

/**
 * The same call, finished.
 *
 * It differs from the real post only in the three fields the gates read, and
 * it keeps `Event` as the SMS name on purpose: if anything ever starts reading
 * `Event` again, every test in the "a finished call" block fails at once.
 */
const completed = (over: Record<string, unknown> = {}) => ({
  ...POST,
  'Current Status': 'completed',
  'Disposition Status': 'completed',
  'Talk Time': 95,
  Duration: 130,
  ...over,
});

describe('Event is not a discriminator, which is what the first gate got wrong', () => {
  it('ingests a finished call whose event still says SMS', () => {
    // The whole correction in one assertion. An allow-list of
    // `…Call-DispositionCompleted` events rejected this, and therefore
    // everything, because Aloware never sends that name.
    const r = normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).not.toBeNull();
    expect(r.row!.externalId).toBe('985097163');
  });

  it('is indifferent to the event, including a missing one', () => {
    for (const event of [
      'OutboundCall-DispositionCompleted',
      'InboundSMS-DispositionCompleted',
      'anything at all',
      '',
      undefined,
    ]) {
      const r = normalizeWebhookCall(completed({ Event: event }), DEFAULT_ALOWARE_MAPPING, TZ);
      expect(r.row, `event ${String(event)}`).not.toBeNull();
    }
  });
});

describe('the ringing post, which is what must never be ingested', () => {
  it('is rejected as in flight, and names the status', () => {
    const r = normalizeWebhookCall(POST, DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('call still in flight');
    expect((r as { type?: string }).type).toBe('ringing');
  });

  it('is rejected on its disposition too, so neither gate carries it alone', () => {
    // `in-progress` is in none of the three disposition lists, and those lists
    // came from 28,863 real calls rather than from a guess about this payload.
    const r = normalizeWebhookCall(
      { ...POST, 'Current Status': 'completed' },
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('not a finished outcome');
    expect((r as { type?: string }).type).toBe('in-progress');
  });
});

describe('Type is the channel gate', () => {
  it('takes the observed call code, and the export word as well', () => {
    expect(normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ).row).not.toBeNull();
    expect(
      normalizeWebhookCall(completed({ Type: 'call' }), DEFAULT_ALOWARE_MAPPING, TZ).row,
    ).not.toBeNull();
  });

  it('rejects a type nobody has listed rather than reading its event name', () => {
    const r = normalizeWebhookCall(completed({ Type: 2 }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('not a call');
    expect((r as { type?: string }).type).toBe('2');
  });

  it('rejects a blank type by name', () => {
    const r = normalizeWebhookCall(completed({ Type: '' }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect((r as { type?: string }).type).toBe('(blank)');
  });
});

describe('talk time and duration are recorded, never gates', () => {
  it('ingests an unanswered call, which is most of a dialler output', () => {
    // Requiring talk time would drop every attempt and leave only the
    // conversations, reporting a connect rate near 100%.
    const r = normalizeWebhookCall(
      completed({ 'Disposition Status': 'no-answer', 'Talk Time': 0, Duration: 22 }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).not.toBeNull();
    expect(r.row!.outcome).toBe('attempted');
    expect(r.row!.talkTimeSeconds).toBe(0);
  });

  it('ingests a dial that failed instantly, zero duration and all', () => {
    // Still the desk responding, and still the timestamp speed to lead reads.
    const r = normalizeWebhookCall(
      completed({ 'Disposition Status': 'failed', 'Talk Time': 0, Duration: 0 }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).not.toBeNull();
    expect(r.row!.durationSeconds).toBe(0);
  });

  it('classifies talk time against the threshold, as the export does', () => {
    expect(normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ).row!.outcome).toBe(
      'connected',
    );
    const brief = normalizeWebhookCall(completed({ 'Talk Time': 4 }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(brief.row!.outcome).toBe('attempted');
    expect(brief.row!.answeredBriefly).toBe(true);
  });
});

describe('a finished call reads every field the export used to supply', () => {
  it('reads the flat and the nested ones', () => {
    const r = normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row!.talkTimeSeconds).toBe(95);
    expect(r.row!.durationSeconds).toBe(130);
    expect(r.row!.contactExternalId).toBe('169745494');
    // Reached through the nested `User` object by dotted path.
    expect(r.row!.agentName).toBe('Oscar Huamani');
    // `Lead Number`, not `Destination Number` — that one is `client:agent123260`
    // and joins to nothing.
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
});

describe('the gates fail closed', () => {
  it('rejects everything when the tenant has no webhook profile', () => {
    const noProfile: AlowareMapping = { ...DEFAULT_ALOWARE_MAPPING, webhook: undefined };
    const r = normalizeWebhookCall(completed(), noProfile, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toContain('no webhook mapping');
  });

  it('treats a blank status as in flight rather than as finished', () => {
    // A post that does not say where the call is has not said it is over, and
    // an unknown-status deny-list has to fail in the direction that costs a log
    // line rather than a phantom call.
    const r = normalizeWebhookCall(
      completed({ 'Current Status': '' }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('call still in flight');
    expect((r as { type?: string }).type).toBe('(blank)');
  });

  it('rejects a disposition the import does not know, rather than absorbing it', () => {
    const r = normalizeWebhookCall(
      completed({ 'Disposition Status': 'transferred-to-voicemail-drop' }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).toBeNull();
    expect((r as { type?: string }).type).toBe('transferred-to-voicemail-drop');
  });

  it('lets an unobserved finished status through, which is the deny-list bargain', () => {
    // The cost of a deny-list: a status nobody listed passes if the disposition
    // is terminal. That is the right way round — the first gate rejected every
    // real delivery, and a status is corrected by the next post on the same ID.
    const r = normalizeWebhookCall(
      completed({ 'Current Status': 'hungup' }),
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row).not.toBeNull();
  });

  it('still refuses a post with no communication id', () => {
    const r = normalizeWebhookCall(completed({ ID: '' }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).toBeNull();
    expect((r as { reason: string }).reason).toBe('no Communication ID');
  });
});
