/**
 * Reading the bands a CRM form actually stores.
 *
 * Spartan's revenue and time-in-business answers do not arrive as numbers. They
 * arrive as picklist labels and free text, in several vocabularies that
 * accumulated over the life of the org — `< $15,000`, `$10K - $25K`, `10-25k`,
 * `&lt; $10,000`, `Menos de 15.000 dólares`, `12 Months +`, `x12_Months_plus`,
 * `New Business`. 69% of inbound leads carry both inputs in some form; none of
 * them carry both as a number.
 *
 * So a band has to become an interval, and an interval compared against a
 * threshold has three answers rather than two:
 *
 *   `< $10,000`            entirely below a $10,000 bar  -> false
 *   `$10,000 - $25,000`    entirely at or above it       -> true
 *   `< $15,000`            contains the bar              -> **null**
 *
 * That third case is the point of this module. It is not a rounding problem to be
 * resolved by picking a midpoint: a lead whose form says "less than $15,000"
 * may be at $4,000 or at $14,000, and the bar sits between them. Answering
 * either way would move a headline rate on evidence that does not exist, so it
 * returns null and the caller reports it as coverage rather than as an outcome.
 */

export type NumericRange = {
  /** Inclusive lower bound. Null is unbounded below. */
  low: number | null;
  /** Upper bound. Null is unbounded above. */
  high: number | null;
  /** True when `high` is exclusive — `< $15,000` excludes 15,000 itself. */
  highExclusive: boolean;
};

export type BandReading =
  | { kind: 'range'; range: NumericRange }
  /** A label that is not a quantity: "New Business", "Not Started". */
  | { kind: 'categorical'; label: string }
  /** Present, but this module will not guess at it. */
  | { kind: 'unreadable' };

const CATEGORICAL = /^(new business|not.?started|n\/?a|unknown|none|tbd|pending)$/i;

/** Shared normalisation: entity-escaped, dash-varied, double-spaced real data. */
function normalise(raw: string): string {
  return raw
    .trim()
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[‒-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

type Token = { value: number; suffix: 'k' | 'm' | null };

/**
 * Numbers with their magnitude suffixes, then the suffix carried backwards.
 *
 * `10-25k` means $10k to $25k, not $10 to $25,000: the writer applied the
 * suffix once at the end and expected it to govern both. An unsuffixed token
 * below 1,000 beside a suffixed one takes that suffix. `$10,000 - $25K` is left
 * alone, because 10,000 is already a plausible magnitude on its own — which is
 * the distinction that makes this safe rather than a guess.
 */
function tokens(text: string): number[] {
  const found: Token[] = [];
  // The suffix must be a whole word. Without the boundary, `m` matched the
  // first letter of "months" and `< 12 Months` became twelve million months —
  // and `million` was only ever seen as a bare `m` followed by "illion".
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:(k|m|million|thousand)\b)?/g)) {
    const digits = match[1]!.replace(/,/g, '');
    const value = Number(digits);
    // Zero is kept. `0 - 1 Years` has a genuine zero lower bound, and dropping
    // it collapsed the band to the point value 1 year — which reads as exactly
    // twelve months and clears a twelve-month bar, when the band admits three.
    if (!Number.isFinite(value)) continue;
    const word = match[2];
    const suffix = word === 'k' || word === 'thousand' ? 'k' : word === 'm' || word === 'million' ? 'm' : null;
    found.push({ value, suffix });
  }
  const carried = found.find((t) => t.suffix)?.suffix ?? null;
  return found.map((t) => {
    const suffix = t.suffix ?? (t.value < 1000 ? carried : null);
    const factor = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
    return t.value * factor;
  });
}

/** `15.000` in a Spanish string is fifteen thousand, not fifteen. */
function deEuropeanise(text: string): string {
  return /menos de|m[aá]s de/.test(text) ? text.replace(/(\d)\.(\d{3})\b/g, '$1$2') : text;
}

function readRange(raw: string, scale: number): BandReading {
  let text = normalise(raw);
  if (CATEGORICAL.test(text)) return { kind: 'categorical', label: raw.trim() };
  text = deEuropeanise(text);

  const below = /(^|\s)<|less than|under|below|menos de|fewer than/.test(text);
  const above = /\+|(^|\s)>|more than|over|greater than|at least|m[aá]s de|plus/.test(text);

  const values = tokens(text).map((v) => v / scale);
  if (values.length === 0) return { kind: 'unreadable' };

  // A leading "<" wins over a trailing "+": `< 12 months` is bounded above
  // whatever else the label says.
  if (below) {
    return { kind: 'range', range: { low: null, high: Math.min(...values), highExclusive: true } };
  }
  if (above) {
    return { kind: 'range', range: { low: Math.max(...values), high: null, highExclusive: false } };
  }
  if (values.length >= 2) {
    return {
      kind: 'range',
      range: { low: Math.min(...values), high: Math.max(...values), highExclusive: false },
    };
  }
  return { kind: 'range', range: { low: values[0]!, high: values[0]!, highExclusive: false } };
}

/**
 * A money band, read into **monthly** units.
 *
 * `period` says what the field means, not what the label says: a field named
 * for annual revenue holding `Less than $180,000` is $15,000 a month, and it
 * straddles a $10,000 monthly bar exactly as its monthly twin does.
 */
export function readMoneyBand(raw: string, period: 'monthly' | 'annual'): BandReading {
  return readRange(raw, period === 'annual' ? 12 : 1);
}

/**
 * A duration band, read into **months**.
 *
 * The unit comes from the label, because one picklist mixes both: `< 12 Months`
 * and `1 - 3 Years` are values of the same field.
 */
export function readDurationBand(raw: string): BandReading {
  const text = normalise(raw);
  if (CATEGORICAL.test(text)) return { kind: 'categorical', label: raw.trim() };
  const inYears = /year|yr/.test(text) && !/month|mo\b/.test(text);
  return readRange(raw, inYears ? 1 / 12 : 1);
}

/**
 * Does the whole interval clear the minimum?
 *
 * `true` when every value it admits does, `false` when none does, and `null`
 * when the minimum falls inside it — the case a midpoint would paper over.
 */
export function rangeMeetsMinimum(range: NumericRange, minimum: number): boolean | null {
  if (range.low != null && range.low >= minimum) return true;
  if (range.high != null && (range.highExclusive ? range.high <= minimum : range.high < minimum)) {
    return false;
  }
  return null;
}

export type BandVerdict = {
  /** `null` is undeterminable: a straddling band, or one nothing could read. */
  meets: boolean | null;
  /** Why, when `meets` is null. One of `straddles` / `categorical` / `unreadable`. */
  reason: 'resolved' | 'straddles' | 'categorical' | 'unreadable';
};

/**
 * The whole judgement for one stored answer.
 *
 * A categorical label is not a quantity, with one exception the caller decides:
 * "New Business" and "Not Started" describe a business with no trading history,
 * which fails a minimum *duration* outright rather than being unknown. Passing
 * `categoricalMeans` says so explicitly at the call site, because the same
 * label against a revenue minimum means nothing at all.
 */
export function judgeBand(
  reading: BandReading,
  minimum: number,
  categoricalMeans: boolean | null = null,
): BandVerdict {
  if (reading.kind === 'categorical') {
    return { meets: categoricalMeans, reason: categoricalMeans === null ? 'categorical' : 'resolved' };
  }
  if (reading.kind === 'unreadable') return { meets: null, reason: 'unreadable' };
  const meets = rangeMeetsMinimum(reading.range, minimum);
  return { meets, reason: meets === null ? 'straddles' : 'resolved' };
}
