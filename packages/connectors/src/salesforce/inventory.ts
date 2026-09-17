import { SalesforceApiError, type DescribeField, type SalesforceClient } from './client';

/**
 * A field inventory for Lead.
 *
 * Answers, per concept: which fields could carry it, how often each is actually
 * populated, and which one to use. Existence is not the question — a field
 * nobody fills in produces a slice of the funnel that looks like a measurement
 * and is not one.
 *
 * Population is counted exactly rather than sampled. SOQL's `COUNT(field)`
 * excludes nulls, so one aggregate query gives a true rate over every lead in
 * the org instead of over whichever 2,000 happened to be most recent — and
 * recent leads are exactly the ones most likely to have a newly added field
 * populated, which would flatter every rate.
 *
 * Exactness is not enough on its own, which the first run against Spartan's org
 * proved: 87% of its leads were a cold-outreach list load, a population with
 * appended firmographics and no attribution, and the exact org-wide rates were
 * averages of two disjoint groups that described neither. A field read 90%
 * across the org and 29% across the leads the engagement was about.
 *
 * So the inventory takes a `scope` — the same SOQL predicate the sync ingests
 * by — and every rate it reports is a rate within that population. An unscoped
 * inventory is still available and still exact, and for an org running one kind
 * of lead it is the same answer; it is simply not the answer of record here.
 */

export type FieldCandidate = {
  apiName: string;
  label: string;
  type: string;
  custom: boolean;
  populated: number;
  total: number;
  /** Null when the field could not be counted (see `note`). */
  rate: number | null;
  note?: string;
};

export type ConceptInventory = {
  concept: string;
  /** What the platform uses it for, so a low rate can be judged in context. */
  usedFor: string;
  candidates: FieldCandidate[];
  /** The highest-populated candidate, or null when none was found. */
  recommended: FieldCandidate | null;
  /** True when nothing reaches the usable threshold. */
  belowThreshold: boolean;
  /** True when the concept has no candidate at all. */
  absent: boolean;
};

export const USABLE_THRESHOLD = 0.5;

type ConceptSpec = {
  concept: string;
  usedFor: string;
  patterns: RegExp[];
  types: string[];
  /** Exact API names to include regardless of pattern — the standard fields. */
  standard?: string[];
  /**
   * Exact API names never to consider, however well they match. `PhotoUrl` is
   * a URL on every Lead and has nothing to do with a landing page; without this
   * a generous pattern promotes it to the recommendation on population alone.
   */
  exclude?: string[];
};

/**
 * Patterns are deliberately generous. A false candidate costs one row in a
 * report that a human reads; a missed one costs a silently absent slice.
 */
const CONCEPTS: ConceptSpec[] = [
  {
    concept: 'monthly revenue',
    usedFor: 'The MQL bar, and qualified_rate. Compared against $10,000/month.',
    patterns: [/month.*(revenue|gross|sales|volume|deposit)/i, /\bmrr\b/i, /(revenue|gross|sales|deposit).*month/i],
    types: ['currency', 'double', 'int', 'percent'],
  },
  {
    concept: 'annual revenue',
    usedFor: 'The MQL bar, normalised to a monthly basis by dividing by twelve.',
    patterns: [/annual.*(revenue|gross|sales|volume)/i, /(revenue|gross|sales).*annual/i, /year.*(revenue|gross|sales)/i, /\barr\b/i],
    types: ['currency', 'double', 'int'],
    standard: ['AnnualRevenue'],
  },
  {
    concept: 'time in business',
    usedFor: 'The MQL bar. Compared against 12 months.',
    patterns: [/time.?in.?business/i, /year.?in.?business/i, /month.?in.?business/i, /\btib\b/i, /business.?start/i, /date.?established/i, /inception/i, /incorporat/i],
    types: ['currency', 'double', 'int', 'date', 'datetime'],
  },
  {
    concept: 'industry',
    usedFor: 'Funnel slicing. Approval rates vary sharply by industry.',
    patterns: [/industry/i, /\bsic\b/i, /\bnaics\b/i, /vertical/i, /business.?type/i],
    types: ['picklist', 'string', 'multipicklist'],
    standard: ['Industry'],
  },
  {
    concept: 'state',
    usedFor: 'Funnel slicing. Approval rates vary sharply by state.',
    patterns: [/^state/i, /province/i, /state.?code/i],
    types: ['picklist', 'string'],
    standard: ['State', 'StateCode'],
  },
  {
    concept: 'utm source',
    usedFor: 'Channel attribution where no click ID is present.',
    patterns: [/utm.?source/i, /^source$/i, /lead.?source.?detail/i],
    types: ['string', 'picklist', 'textarea'],
    standard: ['LeadSource'],
  },
  {
    concept: 'utm medium',
    usedFor: 'Channel attribution where no click ID is present.',
    patterns: [/utm.?medium/i, /\bmedium\b/i],
    types: ['string', 'picklist', 'textarea'],
  },
  {
    concept: 'utm campaign',
    usedFor: 'Campaign-level reporting where no click ID is present.',
    patterns: [/utm.?campaign/i, /campaign.?name/i],
    types: ['string', 'picklist', 'textarea'],
  },
  {
    concept: 'utm content',
    usedFor: 'Creative-level reporting.',
    patterns: [/utm.?content/i, /ad.?content/i],
    types: ['string', 'picklist', 'textarea'],
  },
  {
    concept: 'utm term',
    usedFor: 'Keyword-tier reporting.',
    patterns: [/utm.?term/i, /keyword/i, /search.?term/i],
    types: ['string', 'picklist', 'textarea'],
  },
  {
    concept: 'landing page',
    usedFor: 'Landing-page performance, and A/B test attribution.',
    // The first probe of this org recommended `Landing_Page_Variant__c`, whose
    // values are A/B labels like "lp1" — not a landing page at all — while
    // missing `referral_url__c`, `Referrer_Source__c` and `pi__url__c`, the last
    // of which is the best-covered field in the inventory. `referr`, `referral`
    // and a bare `url` close that gap. A bare `url` is deliberately broad: a
    // false candidate costs one row in a report a human reads, a missed one
    // costs a silently absent slice.
    patterns: [
      /landing.?page/i,
      /landing.?url/i,
      /first.?page/i,
      /entry.?url/i,
      /page.?url/i,
      /referr/i,
      /referral/i,
      /url/i,
    ],
    types: ['string', 'url', 'textarea'],
    exclude: ['PhotoUrl'],
  },
];

/** Long text areas cannot be aggregated in SOQL, so they are counted by sample. */
const NOT_AGGREGATABLE = new Set(['textarea', 'longtextarea', 'encryptedstring', 'base64']);

function matches(field: DescribeField, spec: ConceptSpec): boolean {
  if (spec.exclude?.some((name) => name.toLowerCase() === field.name.toLowerCase())) return false;
  if (spec.standard?.some((name) => name.toLowerCase() === field.name.toLowerCase())) return true;
  if (!spec.types.includes(field.type)) return false;
  return spec.patterns.some((p) => p.test(field.name) || p.test(field.label));
}

export type InventoryScope = {
  /**
   * SOQL predicate every count is taken within — normally `inboundClause()` of
   * the tenant's lead exclusion, so the rates match what the sync ingests.
   */
  where?: string | null;
  /** Human name for that population, carried into the rendered report. */
  label?: string;
  threshold?: number;
};

export async function probeLeadFieldInventory(
  client: SalesforceClient,
  scope: InventoryScope = {},
): Promise<ConceptInventory[]> {
  const threshold = scope.threshold ?? USABLE_THRESHOLD;
  const where = scope.where ? ` WHERE ${scope.where}` : '';
  const lead = await client.describe('Lead');

  const byConcept = new Map<string, DescribeField[]>();
  const allFields = new Map<string, DescribeField>();
  for (const spec of CONCEPTS) {
    const found = lead.fields.filter((f) => matches(f, spec));
    byConcept.set(spec.concept, found);
    for (const f of found) allFields.set(f.name, f);
  }

  const aggregatable = [...allFields.values()].filter((f) => !NOT_AGGREGATABLE.has(f.type));
  const sampled = [...allFields.values()].filter((f) => NOT_AGGREGATABLE.has(f.type));

  const counts = new Map<string, number>();
  let total = 0;

  if (aggregatable.length > 0) {
    // SOQL caps the number of aggregate expressions, so this goes in batches.
    for (let i = 0; i < aggregatable.length; i += 20) {
      const batch = aggregatable.slice(i, i + 20);
      const selects = batch.map((f, n) => `COUNT(${f.name}) c${n}`).join(', ');
      const [row] = await client.query<Record<string, number>>(
        `SELECT COUNT(Id) total, ${selects} FROM Lead${where}`,
      );
      if (!row) continue;
      total = Number(row.total ?? 0);
      batch.forEach((f, n) => counts.set(f.name, Number(row[`c${n}`] ?? 0)));
    }
  } else {
    const [row] = await client.query<Record<string, number>>(
      `SELECT COUNT(Id) total FROM Lead${where}`,
    );
    total = Number(row?.total ?? 0);
  }

  // Long text areas: counted over a sample, and labelled as such rather than
  // quietly presented alongside exact figures.
  const sampleNotes = new Map<string, string>();
  // The denominator for a sampled field is the number of rows that actually
  // came back, not the cap — a smaller org, or a truncated page, would
  // otherwise divide by a sample size that was never read.
  let sampleSize = 0;
  if (sampled.length > 0) {
    const rows = await client.query<Record<string, unknown>>(
      `SELECT Id, ${sampled.map((f) => f.name).join(', ')} FROM Lead${where} ` +
        `ORDER BY CreatedDate DESC LIMIT 2000`,
    );
    sampleSize = rows.length;
    for (const f of sampled) {
      const populated = rows.filter((r) => r[f.name] != null && String(r[f.name]).trim() !== '').length;
      counts.set(f.name, populated);
      sampleNotes.set(
        f.name,
        `sampled over the ${rows.length} most recent leads \u2014 this type cannot be counted exactly`,
      );
    }
  }

  return CONCEPTS.map((spec) => {
    const fields = byConcept.get(spec.concept) ?? [];
    const candidates: FieldCandidate[] = fields
      .map((f) => {
        const note = sampleNotes.get(f.name);
        const denominator = note ? sampleSize : total;
        const populated = counts.get(f.name) ?? 0;
        return {
          apiName: f.name,
          label: f.label,
          type: f.type,
          custom: f.custom,
          populated,
          total: denominator,
          rate: denominator === 0 ? null : populated / denominator,
          note,
        };
      })
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || a.apiName.localeCompare(b.apiName));

    const recommended = candidates[0] ?? null;
    return {
      concept: spec.concept,
      usedFor: spec.usedFor,
      candidates,
      recommended,
      belowThreshold: recommended != null && (recommended.rate ?? 0) < threshold,
      absent: candidates.length === 0,
    };
  });
}

/** Renders the inventory as the table a human actually reads. */
export function formatInventory(inventories: readonly ConceptInventory[]): string {
  const lines: string[] = [];
  const pctOf = (c: FieldCandidate) =>
    c.rate == null ? 'no leads' : `${(c.rate * 100).toFixed(1)}% (${c.populated} of ${c.total})`;

  for (const inv of inventories) {
    const flag = inv.absent ? 'ABSENT ' : inv.belowThreshold ? 'LOW    ' : 'ok     ';
    lines.push(`${flag}  ${inv.concept}`);
    lines.push(`           ${inv.usedFor}`);

    if (inv.absent) {
      lines.push('           No field on Lead looks like it carries this.');
      lines.push('');
      continue;
    }

    for (const c of inv.candidates) {
      const mark = c === inv.recommended ? '→' : ' ';
      lines.push(
        `         ${mark} ${c.apiName} (${c.type}${c.custom ? '' : ', standard'}) — ${pctOf(c)}` +
          (c.note ? `  [${c.note}]` : ''),
      );
    }

    if (inv.belowThreshold) {
      lines.push(
        '           Below 50%. Anything built on this would be a slice of the funnel',
      );
      lines.push(
        '           that looks like a measurement and is not one — cut it, or show',
      );
      lines.push('           the unpopulated share explicitly beside it.');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function safeLeadFieldInventory(
  client: SalesforceClient,
  scope: InventoryScope = {},
): Promise<{ inventories: ConceptInventory[]; error?: string }> {
  try {
    return { inventories: await probeLeadFieldInventory(client, scope) };
  } catch (error) {
    return {
      inventories: [],
      error:
        error instanceof SalesforceApiError
          ? `${error.status} on ${error.path}: ${error.body.slice(0, 200)}`
          : String(error),
    };
  }
}
