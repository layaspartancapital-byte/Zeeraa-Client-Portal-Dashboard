/**
 * Phone numbers, as a join key.
 *
 * Calls arrive from the dialer carrying a number and nothing else that points
 * at a lead, so the number is the join. That makes normalisation a correctness
 * problem rather than a formatting one: two renderings of the same number must
 * produce the same key, and two different numbers must never produce the same
 * key. A join that is wrong in the second direction attributes one merchant's
 * calls to another merchant's lead, which is worse than not joining at all.
 *
 * The rule is deliberately strict and deliberately narrow:
 *
 *   * only a North American ten-digit number produces a key — this engagement
 *     is one US broker, and a rule that also half-handles international
 *     numbers would produce keys nobody has checked;
 *   * anything else returns null, is counted, and shows up as unjoinable
 *     coverage on screen rather than as a silent non-match;
 *   * no prefix or suffix matching, ever. `555-0100` is not evidence about
 *     `(212) 555-0100`.
 */

/** Ten digits, no formatting. The only shape that joins. */
export type PhoneKey = string;

/**
 * Why a number could not be keyed. Carried so the UI can say which kind of
 * gap it is: a blank field and a number with an extension are different
 * conversations with the client.
 */
export type PhoneRejection = 'empty' | 'too_short' | 'not_north_american';

export type PhoneReading =
  | { key: PhoneKey; raw: string }
  | { key: null; raw: string; rejected: PhoneRejection };

/**
 * `1` is the North American country code and the only one accepted, and it is
 * stripped rather than kept: the dialer writes `+13125551234` while a CRM
 * writes `(312) 555-1234`, and those are one number.
 */
export function readPhone(raw: unknown): PhoneReading {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return { key: null, raw: text, rejected: 'empty' };

  /*
   * An extension is dropped, not parsed: `x204` is a desk, not part of the
   * number, and keeping it would split one number into several keys.
   *
   * Matched without a trailing word boundary, because there is none — the `x`
   * in `x204` is followed by a digit, so `\bx\b` never fires and the digits
   * of the extension end up concatenated onto the number.
   */
  const withoutExtension = text.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '');
  let digits = withoutExtension.replace(/\D+/g, '');

  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);

  if (digits.length < 10) {
    return { key: null, raw: text, rejected: digits.length === 0 ? 'empty' : 'too_short' };
  }
  if (digits.length > 10) {
    /*
     * Longer than ten digits with no North American country code. It is a
     * foreign number, or a mistyped one, and nothing here can tell those
     * apart — so it is reported as what is actually known rather than sorted
     * into a guess. Either way it is unjoinable, and guessing where to cut
     * would be the prefix match this module exists to refuse.
     */
    return { key: null, raw: text, rejected: 'not_north_american' };
  }

  // A North American area code and exchange both start 2-9. A number failing
  // that is not a phone number, and treating it as one would let placeholders
  // like 0000000000 collapse many leads onto one key.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) {
    return { key: null, raw: text, rejected: 'not_north_american' };
  }

  return { key: digits, raw: text };
}

/** The key alone, for callers that have already handled the null case. */
export function phoneKey(raw: unknown): PhoneKey | null {
  const reading = readPhone(raw);
  return reading.key;
}

/** `(312) 555-1234`, for display only. Never stored, never joined on. */
export function formatPhone(key: PhoneKey): string {
  if (!/^\d{10}$/.test(key)) return key;
  return `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;
}
