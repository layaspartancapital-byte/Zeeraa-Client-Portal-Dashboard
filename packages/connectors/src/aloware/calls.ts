import { parseWallClock, readPhone, type CallOutcome } from '@zeeraa/core';

/**
 * Aloware calls.
 *
 * Deliberately not read from Salesforce. The org holds 30,093
 * `Aloware_Call__c` records, and reading those would make this platform's call
 * data a copy of a copy: its completeness would depend on the vendor's own
 * Salesforce integration, and a gap in that integration would be
 * indistinguishable here from a quiet day on the phones. So calls come from
 * Aloware directly — a CSV export for the history, a webhook for everything
 * after it — and both land in one shape through one normaliser, so a call that
 * arrives twice by two routes is one call.
 *
 * **`Communication ID` is the natural key**, which is what makes that true. A
 * re-import of an overlapping export and a webhook re-delivery both upsert the
 * same row. Nothing here appends.
 */

/** The shape both routes produce. */
export type CallRow = {
  /** Aloware's Communication ID. The upsert key. */
  externalId: string;
  occurredAt: Date;
  direction: 'inbound' | 'outbound' | 'unknown';
  outcome: CallOutcome;
  /** The vendor's own status, verbatim, so a reclassification is a query. */
  disposition: string | null;
  talkTimeSeconds: number | null;
  durationSeconds: number | null;
  contactNumber: string | null;
  /** Ten digits, or null when the number cannot be keyed. */
  contactKey: string | null;
  contactExternalId: string | null;
  agentName: string | null;
  /**
   * A completed call shorter than the connected threshold.
   *
   * Counted as `attempted`, and flagged so the count is not lost: 13,376 calls
   * in this export were answered by something and over inside nine seconds,
   * which is a finding about the list rather than about the desk.
   */
  answeredBriefly: boolean;
};

export type CallImportResult = {
  rows: CallRow[];
  /** Outcome counts, for the import record. */
  counts: { connected: number; attempted: number; abandoned: number };
  /** Rows that were not calls at all, by the `Type` they carried. */
  skippedByType: Record<string, number>;
  /**
   * Rows dropped, with the reason. A dropped row is never silent: a call with
   * no Communication ID cannot be de-duplicated and a call with no timestamp
   * cannot be placed in a period, so importing either would corrupt a count
   * that looks fine.
   */
  dropped: Record<string, number>;
  /** Dispositions the mapping does not classify, counted. */
  unclassified: Record<string, number>;
  /** Numbers that produced no join key, by why. */
  unkeyedNumbers: Record<string, number>;
  /** Of the attempted calls, how many were answered and cut short. */
  answeredBriefly: number;
  /** The window the rows actually cover. */
  span: { earliest: Date | null; latest: Date | null };
};

/**
 * Which column holds what, and which values mean what.
 *
 * Configuration, because both are facts about one vendor's export rather than
 * about the product — and because Aloware's own column headers have changed
 * between exports before.
 */
export type AlowareMapping = {
  columns: {
    externalId: string;
    startedAt: string;
    type: string;
    direction: string;
    disposition: string;
    talkTime: string;
    duration: string;
    contactNumber: string;
    contactId: string;
    userName: string;
  };
  /** `Type` values that are calls. Everything else is skipped and counted. */
  callTypes: string[];
  /**
   * Dispositions meaning the call completed as a telephony event.
   *
   * Not the same as a conversation, which is why `connectedMinTalkSeconds`
   * exists. In this export 26,311 of 28,863 calls are `completed` and 13,376
   * of those had between one and nine seconds of talk time — answering
   * machines and immediate hang-ups. Treating `completed` alone as connected
   * reports a 91% connect rate on outbound dialling.
   */
  connectedDispositions: string[];
  /** Dispositions meaning the caller hung up before anybody answered. */
  abandonedDispositions: string[];
  /**
   * Dispositions meaning an agent tried and did not reach anybody.
   *
   * Listed rather than inferred as "everything else", so that a new
   * disposition value is reported instead of quietly joining this bucket and
   * moving the connect rate.
   */
  attemptedDispositions: string[];
  /**
   * How long a completed call must have been talking to count as connected.
   *
   * A judgement about what a conversation is, so it is configuration rather
   * than a constant, and it is shown on screen beside the figure it decides.
   * The sensitivity is steep in this data — at 1s, 23,355 calls are connected;
   * at 10s, 9,979; at 30s, 3,503 — which is exactly why the number must be
   * visible rather than buried.
   *
   * A completed call below the threshold is `attempted`: something answered,
   * but nothing that supports a claim about reaching the merchant.
   */
  connectedMinTalkSeconds: number;
  /**
   * The webhook's own shape, which is not the export's.
   *
   * Aloware's Zapier "Call Disposed" trigger posts different field names,
   * different types and a different discriminator from the CSV: `ID` rather
   * than `Communication ID`, `Created At` rather than `Started At`, `Type` as
   * `1` rather than `"call"`, `Direction` as `2` rather than `"outbound"`, and
   * the agent's name nested under `User`. Read with the export's mapping,
   * every post was rejected as "not a call (blank)" — which is why the webhook
   * had delivered nothing even before anybody checked the subscription.
   *
   * Absent means the tenant has no webhook configured and the endpoint refuses
   * everything, which is the correct state for a client whose subscription has
   * not been set up.
   */
  webhook?: AlowareWebhookProfile;
};

export type AlowareWebhookProfile = {
  /** Field names, dotted for a nested one: `User.Name`. */
  columns: AlowareMapping['columns'];
  /**
   * The `Event` values that are a finished call, and the only ones ingested.
   *
   * **An allow-list, because the trigger fires on far more than calls.** The
   * sample that prompted this is `OutboundSMS-DispositionCompleted`: a text
   * message, posted while the call leg was still ringing, with zero duration.
   * A deny-list of the SMS events would have let the next new event type
   * through silently and counted a text as a call.
   *
   * Anything not listed is rejected and counted by its own name, so the
   * endpoint's log says exactly what to add.
   */
  allowedEvents: string[];
  /**
   * `Current Status` values that mean the call is over.
   *
   * The second gate, and independent of the first: an event may be named for a
   * completed disposition while the call itself is still `ringing`, which is
   * exactly what the sample does. Talk time and duration are both zero there,
   * so ingesting it would add a call that never happened and timestamp the
   * desk's response at the moment it started dialling.
   */
  completedStatuses: string[];
  /** Numeric direction codes, because the webhook sends `2` not `outbound`. */
  directions: Record<string, CallRow['direction']>;
  /** Where the call's own status lives. */
  statusColumn: string;
  /** Where the event name lives. */
  eventColumn: string;
};

export const DEFAULT_ALOWARE_MAPPING: AlowareMapping = {
  columns: {
    externalId: 'Communication ID',
    startedAt: 'Started At',
    type: 'Type',
    direction: 'Direction',
    disposition: 'Disposition Status',
    talkTime: 'Talk Time',
    duration: 'Duration',
    contactNumber: 'Contact Number',
    contactId: 'Contact ID',
    userName: 'User Name',
  },
  callTypes: ['call'],
  connectedDispositions: ['completed', 'connected', 'answered', 'complete'],
  abandonedDispositions: ['abandoned', 'abandon'],
  /**
   * The Zapier "Call Disposed" trigger's shape, from a real post of
   * 22 September 2026.
   *
   * Every name here was taken from that payload rather than guessed. The two
   * allow-lists are the exception and are marked as such: the sample is an SMS
   * event on a ringing leg, so it shows what must be *rejected* and not what a
   * finished call looks like. Both default to the completed-call form of the
   * observed convention, and both fail closed — an unlisted value is rejected
   * and logged by name, so confirming them is one config edit rather than a
   * code change.
   */
  webhook: {
    columns: {
      // `ID` is the communication id and the upsert key, the same identity the
      // export calls `Communication ID`.
      externalId: 'ID',
      // A bare wall clock with no offset — `2026-09-22 19:47:42` — exactly as
      // the export writes it, so it goes through `parseWallClock` in the
      // tenant's zone. Reading it as UTC would put every call four hours early
      // and make speed to lead read as neglect.
      startedAt: 'Created At',
      // Present as `1`, and not the discriminator. `allowedEvents` is.
      type: 'Type',
      direction: 'Direction',
      disposition: 'Disposition Status',
      talkTime: 'Talk Time',
      duration: 'Duration',
      // The merchant's number. `Incoming Number` is Aloware's own line and
      // `Destination Number` is `client:agent123260`, neither of which joins
      // to a lead.
      contactNumber: 'Lead Number',
      contactId: 'Contact Id',
      userName: 'User.Name',
    },
    // INFERRED from `OutboundSMS-DispositionCompleted`, the one event observed.
    // Confirm against a real call before trusting the count.
    allowedEvents: ['InboundCall-DispositionCompleted', 'OutboundCall-DispositionCompleted'],
    // INFERRED. The observed value is `ringing`, which is what must not pass.
    completedStatuses: ['completed'],
    // `2` with an `Outbound…` event name is the evidence for outbound; `1` is
    // its complement and is the one part of this not seen directly.
    directions: { '1': 'inbound', '2': 'outbound' },
    statusColumn: 'Current Status',
    eventColumn: 'Event',
  },
  // Every non-completed disposition this export actually contains, plus the
  // obvious neighbours. An unlisted value is reported rather than absorbed.
  attemptedDispositions: [
    'failed',
    'missed',
    'voicemail',
    'dead-end',
    'invalid',
    'no answer',
    'no-answer',
    'noanswer',
    'busy',
    'left voicemail',
    'canceled',
    'cancelled',
    'unreachable',
    'rejected',
  ],
  connectedMinTalkSeconds: 30,
};

const norm = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * One field, by name or by dotted path.
 *
 * The export is flat; the webhook nests the agent under `User`, the merchant
 * under `Contact` and the line under `Campaign`. A dotted path keeps both
 * shapes describable by configuration rather than forcing a second reader.
 */
function readField(record: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return record[path];
  let cursor: unknown = record;
  for (const part of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Seconds from whatever the export wrote.
 *
 * Aloware writes plain seconds in some exports and `mm:ss` or `hh:mm:ss` in
 * others. Both are accepted and an unparseable value becomes null rather than
 * zero: a call of unknown length is not a call of no length, and averaging
 * zeros into talk time would understate every conversation.
 */
export function readSeconds(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  const parts = text.split(':');
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p.trim()))) {
    return parts.reduce((total, part) => total * 60 + Number(part.trim()), 0);
  }
  return null;
}

function readDirection(raw: unknown): CallRow['direction'] {
  const value = norm(raw);
  if (value.startsWith('out')) return 'outbound';
  if (value.startsWith('in')) return 'inbound';
  return 'unknown';
}

/**
 * Maps a disposition onto one of three outcomes.
 *
 * An unrecognised disposition is `attempted` *and* reported. Attempted is the
 * conservative direction of the three: calling it connected would invent a
 * conversation, and calling it abandoned would blame the merchant for a call
 * the desk may well have made.
 */
export function classifyDisposition(
  raw: unknown,
  mapping: AlowareMapping,
  talkSeconds: number | null = null,
): { outcome: CallOutcome; recognised: boolean; answeredBriefly: boolean } {
  const value = norm(raw);
  if (mapping.connectedDispositions.some((d) => norm(d) === value)) {
    /*
     * The vendor says the call completed; whether anybody talked is a separate
     * question, and the answer is in the talk time. Below the threshold this is
     * an attempt that something picked up — an answering machine, or a hang-up
     * two seconds in — and `answeredBriefly` records that so the count is not
     * simply lost into `attempted`.
     */
    const talk = talkSeconds ?? 0;
    if (talk >= mapping.connectedMinTalkSeconds) {
      return { outcome: 'connected', recognised: true, answeredBriefly: false };
    }
    return { outcome: 'attempted', recognised: true, answeredBriefly: talk > 0 };
  }
  if (mapping.abandonedDispositions.some((d) => norm(d) === value)) {
    return { outcome: 'abandoned', recognised: true, answeredBriefly: false };
  }
  if (mapping.attemptedDispositions.some((d) => norm(d) === value)) {
    return { outcome: 'attempted', recognised: true, answeredBriefly: false };
  }
  return { outcome: 'attempted', recognised: false, answeredBriefly: false };
}

/**
 * One parsed CSV record, or one webhook payload, into a row.
 *
 * Returns a reason instead of a row when the record cannot be imported, so the
 * caller can count it. Shared by both routes on purpose: a webhook delivery and
 * a CSV line describing the same call must produce byte-identical rows, or the
 * upsert silently rewrites one with the other every time the export is re-run.
 */
export function normalizeCall(
  record: Record<string, unknown>,
  mapping: AlowareMapping,
  /**
   * The tenant's zone, for `Started At`.
   *
   * Required rather than defaulted. The export writes a wall clock with no
   * offset, and the default would be the server's zone — which in a container
   * is UTC, putting every call four hours early and making speed to lead read
   * as neglect. §16: normalised at ingest.
   */
  timeZone: string,
): { row: CallRow } | { row: null; reason: string; type?: string } {
  const c = mapping.columns;

  const type = String(record[c.type] ?? '').trim();
  if (mapping.callTypes.length > 0 && !mapping.callTypes.some((t) => norm(t) === norm(type))) {
    return { row: null, reason: 'not a call', type: type === '' ? '(blank)' : type };
  }

  const externalId = String(record[c.externalId] ?? '').trim();
  if (externalId === '') {
    // Without the natural key there is nothing to de-duplicate on, so this row
    // would double-count on the next import. Dropped rather than imported.
    return { row: null, reason: 'no Communication ID' };
  }

  const startedAt = String(record[c.startedAt] ?? '').trim();
  const occurredAt = startedAt === '' ? null : parseWallClock(startedAt, timeZone);
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    return { row: null, reason: 'no usable Started At' };
  }

  const talkTimeSeconds = readSeconds(record[c.talkTime]);
  const { outcome, answeredBriefly } = classifyDisposition(
    record[c.disposition],
    mapping,
    talkTimeSeconds,
  );
  const phone = readPhone(record[c.contactNumber]);
  const disposition = record[c.disposition] == null ? null : String(record[c.disposition]).trim();
  const agentName = record[c.userName] == null ? null : String(record[c.userName]).trim();
  const contactExternalId = record[c.contactId] == null ? null : String(record[c.contactId]).trim();

  return {
    row: {
      externalId,
      occurredAt,
      direction: readDirection(record[c.direction]),
      outcome,
      disposition: disposition === '' ? null : disposition,
      talkTimeSeconds,
      durationSeconds: readSeconds(record[c.duration]),
      contactNumber: phone.raw === '' ? null : phone.raw,
      contactKey: phone.key,
      contactExternalId: contactExternalId === '' ? null : contactExternalId,
      agentName: agentName === '' ? null : agentName,
      answeredBriefly,
    },
  };
}

/**
 * One webhook post into a row, or a reason it is not a completed call.
 *
 * Two gates before the shared normaliser runs, both allow-lists and both
 * fail-closed. An unconfigured tenant, an unknown event and a call still in
 * flight are each rejected by name, so the endpoint's log says which.
 */
export function normalizeWebhookCall(
  record: Record<string, unknown>,
  mapping: AlowareMapping,
  timeZone: string,
): { row: CallRow } | { row: null; reason: string; type?: string } {
  const profile = mapping.webhook;
  if (!profile) {
    return { row: null, reason: 'no webhook mapping configured for this tenant' };
  }

  const event = String(readField(record, profile.eventColumn) ?? '').trim();
  if (!profile.allowedEvents.some((allowed) => norm(allowed) === norm(event))) {
    // Named rather than bucketed: the point of an allow-list is that the
    // rejected value tells you what to add.
    return { row: null, reason: 'not a call event', type: event === '' ? '(blank)' : event };
  }

  const status = String(readField(record, profile.statusColumn) ?? '').trim();
  if (!profile.completedStatuses.some((done) => norm(done) === norm(status))) {
    return { row: null, reason: 'call not finished', type: status === '' ? '(blank)' : status };
  }

  /*
   * The webhook's own columns, and `callTypes: []` to switch off the export's
   * type check — `Type` is `1` here and the discriminator is `Event`, which the
   * two gates above have already applied.
   */
  const asExport: AlowareMapping = { ...mapping, columns: profile.columns, callTypes: [] };

  const flattened: Record<string, unknown> = { ...record };
  for (const path of Object.values(profile.columns)) {
    if (path.includes('.')) flattened[path] = readField(record, path);
  }

  const result = normalizeCall(flattened, asExport, timeZone);
  if (!result.row) return result;

  // Direction arrives as a code. `readDirection` reads words, so `2` came out
  // `unknown` and every webhook call would have lost the direction that speed
  // to lead is measured on.
  const code = String(readField(record, profile.columns.direction) ?? '').trim();
  return { row: { ...result.row, direction: profile.directions[code] ?? result.row.direction } };
}

/** Many records, with everything the import record needs to be honest. */
export function normalizeCalls(
  records: readonly Record<string, unknown>[],
  timeZone: string,
  mapping: AlowareMapping = DEFAULT_ALOWARE_MAPPING,
): CallImportResult {
  const rows: CallRow[] = [];
  const counts = { connected: 0, attempted: 0, abandoned: 0 };
  const skippedByType: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const unclassified: Record<string, number> = {};
  const unkeyedNumbers: Record<string, number> = {};
  let answeredBriefly = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const record of records) {
    const result = normalizeCall(record, mapping, timeZone);
    if (!result.row) {
      if (result.type !== undefined) {
        skippedByType[result.type] = (skippedByType[result.type] ?? 0) + 1;
      } else {
        dropped[result.reason] = (dropped[result.reason] ?? 0) + 1;
      }
      continue;
    }

    const row = result.row;
    if (row.answeredBriefly) answeredBriefly += 1;
    const classification = classifyDisposition(
      record[mapping.columns.disposition],
      mapping,
      row.talkTimeSeconds,
    );
    if (!classification.recognised) {
      const key = row.disposition ?? '(blank)';
      unclassified[key] = (unclassified[key] ?? 0) + 1;
    }

    if (row.contactKey === null) {
      const reading = readPhone(record[mapping.columns.contactNumber]);
      const why = reading.key === null ? reading.rejected : 'unknown';
      unkeyedNumbers[why] = (unkeyedNumbers[why] ?? 0) + 1;
    }

    counts[row.outcome] += 1;
    if (!earliest || row.occurredAt < earliest) earliest = row.occurredAt;
    if (!latest || row.occurredAt > latest) latest = row.occurredAt;
    rows.push(row);
  }

  return {
    rows,
    counts,
    skippedByType,
    dropped,
    unclassified,
    unkeyedNumbers,
    answeredBriefly,
    span: { earliest, latest },
  };
}
