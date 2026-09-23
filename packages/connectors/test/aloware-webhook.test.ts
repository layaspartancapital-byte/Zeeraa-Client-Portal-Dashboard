import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALOWARE_MAPPING,
  normalizeCall,
  normalizeWebhookCall,
  type AlowareMapping,
} from '../src/aloware/calls';

/**
 * The Zapier "Call Disposed" payload, from a real post of 22 September 2026.
 *
 * Trimmed to the fields the reader touches, with the nesting kept — `User` is
 * an object, and the agent's name is only reachable through it. Every value is
 * as it arrived: `Type` and `Direction` are numbers, `Talk Time` and `Duration`
 * are numbers, `Created At` is a bare UTC timestamp with no offset.
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
 * A real **completed** call from the same trigger, 22 September 2026.
 *
 * The positive case, and the one that was missing: until this arrived, every
 * finished-call value was inferred from a payload that had none. It settles the
 * two gates that were guesses. `Current Status` is `completed` — an observed
 * terminal status at last — and `Type` is `1` on a call that genuinely
 * happened, which is the channel gate confirmed rather than merely uncontradicted.
 *
 * And `Event` is **still** `OutboundSMS-DispositionCompleted`, on a call with
 * 8 seconds of conversation. That is the correction in one field: the event
 * name is not the channel, it is not the state, and it is not evidence of
 * anything. It is kept here deliberately, so that anything which starts reading
 * `Event` again fails this whole block at once.
 *
 * `Duration` 33 = `Wait Time` 25 + `Talk Time` 8, which is the other reason
 * duration cannot stand in for a conversation: most of this call was ringing.
 *
 * The identity and timing fields are carried from the post above, because the
 * completed one was supplied as the fields that decide admission. Everything
 * the gates read is real.
 */
const COMPLETED: Record<string, unknown> = {
  ...POST,
  Event: 'OutboundSMS-DispositionCompleted',
  'Current Status': 'completed',
  'Disposition Status': 'completed',
  Type: 1,
  Direction: 2,
  Duration: 33,
  'Talk Time': 8,
  'Wait Time': 25,
};

const completed = (over: Record<string, unknown> = {}) => ({ ...COMPLETED, ...over });

describe('Event is not a discriminator, which is what the first gate got wrong', () => {
  it('ingests a real completed call whose event still says SMS', () => {
    // The whole correction in one assertion, against a real post. An allow-list
    // of `…Call-DispositionCompleted` events rejected this, and therefore
    // everything, because Aloware never sends that name.
    expect(COMPLETED.Event).toBe('OutboundSMS-DispositionCompleted');
    const r = normalizeWebhookCall(COMPLETED, DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row).not.toBeNull();
    expect(r.row!.direction).toBe('outbound');
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

describe('the two real posts differ in exactly the fields the gates read', () => {
  it('separates them on status and disposition, not on anything else', () => {
    // Same trigger, same `Event`, same `Type`, same `Direction`. Everything
    // that distinguishes the call that happened from the one that had not yet
    // happened is in these two fields, which is the case for gating on them.
    const differing = Object.keys(COMPLETED).filter(
      (key) => COMPLETED[key] !== POST[key],
    );
    expect(differing.sort()).toEqual([
      'Current Status',
      'Disposition Status',
      'Duration',
      'Talk Time',
      'Wait Time',
    ]);
    expect(COMPLETED.Event).toBe(POST.Event);
    expect(COMPLETED.Type).toBe(POST.Type);
  });

  it('confirms `completed` as an observed terminal status', () => {
    // The deny-list was written without ever having seen a finished status.
    // This is that value, and it passes.
    const profile = DEFAULT_ALOWARE_MAPPING.webhook!;
    expect(profile.inFlightStatuses).toContain('ringing');
    expect(profile.inFlightStatuses).not.toContain('completed');
    expect(normalizeWebhookCall(COMPLETED, DEFAULT_ALOWARE_MAPPING, TZ).row).not.toBeNull();
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
    // The real completed call is 8 seconds of talk, which is under the 30s
    // threshold — so a genuine completed call arrives as `attempted`, flagged
    // `answeredBriefly`. That is the same finding the export produced (13,376
    // of 26,311 completed calls under ten seconds), reaching the webhook route
    // unchanged, and it is why `completed` is not a synonym for a conversation.
    const real = normalizeWebhookCall(COMPLETED, DEFAULT_ALOWARE_MAPPING, TZ);
    expect(real.row!.outcome).toBe('attempted');
    expect(real.row!.answeredBriefly).toBe(true);

    const long = normalizeWebhookCall(completed({ 'Talk Time': 95 }), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(long.row!.outcome).toBe('connected');
    expect(long.row!.answeredBriefly).toBe(false);
  });
});

describe('a finished call reads every field the export used to supply', () => {
  it('reads the flat and the nested ones', () => {
    const r = normalizeWebhookCall(COMPLETED, DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row!.talkTimeSeconds).toBe(8);
    expect(r.row!.durationSeconds).toBe(33);
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

  it('reads Created At as UTC, unlike the export', () => {
    // The webhook's bare timestamp is UTC. Read in the tenant's zone — as it
    // was until 23 September 2026 — every webhook call landed four hours late:
    // deliveries that stopped at 20:06Z had stored calls dated 00:04Z the
    // next day.
    const r = normalizeWebhookCall(completed(), DEFAULT_ALOWARE_MAPPING, TZ);
    expect(r.row!.occurredAt.toISOString()).toBe('2026-09-22T19:47:42.000Z');
  });

  it('still reads the export in the tenant zone', () => {
    // The export writes the account's local wall clock: 19:47:42 in New York
    // is 23:47:42Z. The two routes differ, and each is pinned.
    const r = normalizeCall(
      { 'Communication ID': 'x1', 'Started At': '2026-09-22 19:47:42', Type: 'call', Direction: 'outbound', 'Disposition Status': 'completed' },
      DEFAULT_ALOWARE_MAPPING,
      TZ,
    );
    expect(r.row!.occurredAt.toISOString()).toBe('2026-09-22T23:47:42.000Z');
  });

  it('falls back to UTC when a tenant override omits the zone', () => {
    const override: AlowareMapping = {
      ...DEFAULT_ALOWARE_MAPPING,
      webhook: { ...DEFAULT_ALOWARE_MAPPING.webhook!, createdAtZone: undefined as unknown as string },
    };
    const r = normalizeWebhookCall(completed(), override, TZ);
    expect(r.row!.occurredAt.toISOString()).toBe('2026-09-22T19:47:42.000Z');
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
