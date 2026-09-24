import type { SalesforceClient } from './client';

/**
 * Which Lead records belong to this platform at all.
 *
 * Spartan runs a cold-outreach workstream out of the same Salesforce org as its
 * inbound marketing. The two are opposite populations: the cold list carries
 * appended firmographics and no attribution, inbound web leads carry attribution
 * and almost no firmographics. Averaged together, every rate describes a
 * population that does not exist — a field can read 90% across the org and 29%
 * across the leads the engagement is actually about.
 *
 * So cold-outreach records are excluded at the SOQL query and never ingested.
 * This is a read-side exclusion only: nothing in Salesforce is written,
 * modified or deleted, and the records stay exactly as they are in the org.
 *
 * Three properties make the exclusion trustworthy rather than merely effective:
 *
 *   1. It is configuration. The rules live in `tenant_config.lead_exclusion`,
 *      because "who is a cold-outreach owner" is a fact about one client's
 *      operations, not about the product. A second tenant with no cold list
 *      runs the same code with an empty rule set.
 *
 *   2. Anything the rules cannot confidently classify is excluded, not assumed
 *      inbound. A lead that matches no exclusion rule still has to carry a
 *      positive inbound signal to be ingested. The residue is counted and
 *      reported, so the next bulk load — which will not match today's rules —
 *      arrives as a number on the sync run rather than as quiet funnel growth.
 *
 *   3. Every rule's effect is counted separately and written to the sync run,
 *      so the exclusion is auditable after the fact instead of being an
 *      invisible narrowing of the denominator.
 */

export type LeadExclusionRule = {
  /** Stable identifier. Appears in the sync run log; do not rename casually. */
  key: string;
  /** One sentence, rendered in the sync-history view. */
  label: string;
  /** Matches `Owner.Name`. The cold list sits under a holding owner. */
  ownerNames?: string[];
  /** Matches `OwnerId`, for when a display name is ambiguous or renamed. */
  ownerIds?: string[];
  /** ISO 8601 instants. `from` inclusive, `to` exclusive. */
  createdBetween?: { from: string; to: string };
  /**
   * Narrows the rule to records with no `LeadSource`. A bulk-load window
   * without this catches the genuine inbound leads that arrived the same day —
   * on 8 September 2026 that was roughly one lead in ten.
   */
  requireNullLeadSource?: boolean;
  /**
   * Matches `LeadSource` exactly — an outbound list bought in, like ZoomInfo,
   * which is cold outreach under another name (24 September 2026).
   */
  leadSources?: string[];
};

export type LeadExclusionConfig = {
  enabled: boolean;
  rules: LeadExclusionRule[];
  /**
   * A lead matching no exclusion rule is ingested only if at least one of these
   * fields carries a value. Absence of every signal is not evidence of inbound
   * origin — it is absence of evidence, and it is the shape a future bulk load
   * will arrive in.
   */
  inboundSignalFields: string[];
};

export const NO_LEAD_EXCLUSION: LeadExclusionConfig = {
  enabled: false,
  rules: [],
  inboundSignalFields: [],
};

/** SOQL string literal. Backslash first, or the quote escape is re-escaped. */
function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * SOQL datetime literals are unquoted ISO 8601 and must carry an offset — a
 * quoted one is a string comparison against a datetime column and fails.
 *
 * Fractional seconds are accepted by the API (checked against a real org), and
 * are dropped only so the generated clause is stable and readable. Parsing
 * here also turns a malformed config value into a named error at load time
 * rather than a MALFORMED_QUERY at sync time.
 */
function instant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new LeadExclusionConfigError(`"${value}" is not a parseable instant.`);
  }
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class LeadExclusionConfigError extends Error {
  constructor(message: string) {
    super(`lead_exclusion is misconfigured: ${message}`);
    this.name = 'LeadExclusionConfigError';
  }
}

/**
 * One rule as a SOQL predicate. The rule's criteria are ANDed: an owner list
 * plus a window means "this owner, in this window", which is narrower and
 * therefore safer than either alone.
 */
export function ruleClause(rule: LeadExclusionRule): string {
  const parts: string[] = [];

  if (rule.ownerNames?.length) {
    parts.push(`Owner.Name IN (${rule.ownerNames.map(literal).join(', ')})`);
  }
  if (rule.ownerIds?.length) {
    parts.push(`OwnerId IN (${rule.ownerIds.map(literal).join(', ')})`);
  }
  if (rule.createdBetween) {
    parts.push(
      `(CreatedDate >= ${instant(rule.createdBetween.from)} AND ` +
        `CreatedDate < ${instant(rule.createdBetween.to)})`,
    );
  }
  if (rule.requireNullLeadSource) {
    parts.push('LeadSource = null');
  }
  if (rule.leadSources?.length) {
    parts.push(`LeadSource IN (${rule.leadSources.map(literal).join(', ')})`);
  }

  if (parts.length === 0) {
    // A rule with no criteria matches every lead. Silently dropping it would
    // ingest nothing and look like an empty org; throwing names the config row.
    throw new LeadExclusionConfigError(
      `rule "${rule.key}" has no criteria, so it would exclude every lead.`,
    );
  }

  return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
}

/**
 * The same rule, negated.
 *
 * SOQL's `NOT` is not a general boolean operator: it may only prefix a single
 * parenthesised expression at the head of a WHERE clause, so `NOT (a) AND NOT
 * (b)` is a syntax error rather than a filter. Every negation therefore has to
 * be pushed down to the comparisons by De Morgan, which is what this does. The
 * result is a clause of positive operators that composes freely.
 *
 * A rule is an AND of criteria, so its negation is an OR of negated criteria.
 */
export function negatedRuleClause(rule: LeadExclusionRule): string {
  const parts: string[] = [];

  if (rule.ownerNames?.length) {
    parts.push(`Owner.Name NOT IN (${rule.ownerNames.map(literal).join(', ')})`);
  }
  if (rule.ownerIds?.length) {
    parts.push(`OwnerId NOT IN (${rule.ownerIds.map(literal).join(', ')})`);
  }
  if (rule.createdBetween) {
    parts.push(
      `(CreatedDate < ${instant(rule.createdBetween.from)} OR ` +
        `CreatedDate >= ${instant(rule.createdBetween.to)})`,
    );
  }
  if (rule.requireNullLeadSource) {
    parts.push('LeadSource != null');
  }
  if (rule.leadSources?.length) {
    // `NOT IN` alone would say nothing about a lead with no source at all.
    parts.push(`(LeadSource = null OR LeadSource NOT IN (${rule.leadSources.map(literal).join(', ')}))`);
  }

  if (parts.length === 0) {
    throw new LeadExclusionConfigError(
      `rule "${rule.key}" has no criteria, so it would exclude every lead.`,
    );
  }

  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

/** True for a record matching any rule — the cold-outreach population. */
export function excludedClause(config: LeadExclusionConfig): string | null {
  if (!config.enabled || config.rules.length === 0) return null;
  const clauses = config.rules.map(ruleClause);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' OR ')})`;
}

/** True for a record matching no rule. The negation of `excludedClause`. */
export function notExcludedClause(config: LeadExclusionConfig): string | null {
  if (!config.enabled || config.rules.length === 0) return null;
  const clauses = config.rules.map(negatedRuleClause);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' AND ')})`;
}

/** True for a record carrying at least one positive inbound signal. */
export function inboundSignalClause(config: LeadExclusionConfig): string | null {
  if (!config.enabled || config.inboundSignalFields.length === 0) return null;
  const clauses = config.inboundSignalFields.map((f) => `${f} != null`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' OR ')})`;
}

/** True for a record carrying no inbound signal at all. */
export function noInboundSignalClause(config: LeadExclusionConfig): string | null {
  if (!config.enabled || config.inboundSignalFields.length === 0) return null;
  const clauses = config.inboundSignalFields.map((f) => `${f} = null`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' AND ')})`;
}

/**
 * The predicate for records this platform may ingest: not cold, and positively
 * inbound. Returns null when the exclusion is off, so the caller emits no
 * WHERE fragment at all rather than a tautology.
 */
export function inboundClause(config: LeadExclusionConfig): string | null {
  const parts = [notExcludedClause(config), inboundSignalClause(config)].filter(
    (p): p is string => p != null,
  );
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.join(' AND ');
}

/**
 * The predicate for the residue: matched no rule, and carries no inbound
 * signal either. Excluded, and counted — this is where the next bulk load
 * lands before anybody writes a rule for it.
 */
export function unclassifiedClause(config: LeadExclusionConfig): string | null {
  const parts = [notExcludedClause(config), noInboundSignalClause(config)].filter(
    (p): p is string => p != null,
  );
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.join(' AND ');
}

export type ExclusionRuleCount = {
  key: string;
  label: string;
  /**
   * Records matching this rule. Rules may overlap — a record can be both
   * cold-owned and inside the bulk-load window — so these do not sum to
   * `excludedTotal`, and the sync view must not add them up.
   */
  matched: number;
};

export type ExclusionCounts = {
  /** Every lead in the window, before any exclusion. */
  considered: number;
  /** Distinct records matching at least one rule. */
  excludedTotal: number;
  perRule: ExclusionRuleCount[];
  /**
   * Matched no exclusion rule and carried no inbound signal. Excluded, and the
   * number that matters: a future bulk load lands here until a rule names it.
   */
  unclassified: number;
  /** What the sync will actually read. */
  inbound: number;
  /** True when rules overlap, so the per-rule figures are not additive. */
  rulesOverlap: boolean;
};

function windowClause(since: Date | null): string | null {
  return since ? `SystemModstamp > ${instant(since.toISOString())}` : null;
}

function and(...parts: (string | null)[]): string {
  const kept = parts.filter((p): p is string => p != null);
  return kept.length === 0 ? '' : ` WHERE ${kept.join(' AND ')}`;
}

async function count(client: SalesforceClient, where: string): Promise<number> {
  const [row] = await client.query<Record<string, unknown>>(`SELECT COUNT(Id) c FROM Lead${where}`);
  return Number(row?.c ?? 0);
}

/**
 * Counts what the exclusion will do, without ingesting any of it.
 *
 * Runs as aggregates against Salesforce rather than by fetching and discarding,
 * so an excluded record never crosses the wire into Postgres — which is the
 * requirement — while still being counted exactly.
 */
export async function countLeadClassification(
  client: SalesforceClient,
  config: LeadExclusionConfig,
  since: Date | null,
): Promise<ExclusionCounts> {
  const window = windowClause(since);
  const considered = await count(client, and(window));

  if (!config.enabled) {
    return {
      considered,
      excludedTotal: 0,
      perRule: [],
      unclassified: 0,
      inbound: considered,
      rulesOverlap: false,
    };
  }

  const perRule: ExclusionRuleCount[] = [];
  for (const rule of config.rules) {
    perRule.push({
      key: rule.key,
      label: rule.label,
      matched: await count(client, and(window, ruleClause(rule))),
    });
  }

  const excluded = excludedClause(config);
  const excludedTotal = excluded ? await count(client, and(window, excluded)) : 0;
  const unclassified = await count(client, and(window, unclassifiedClause(config)));
  const inboundCount = await count(client, and(window, inboundClause(config)));

  return {
    considered,
    excludedTotal,
    perRule,
    unclassified,
    inbound: inboundCount,
    rulesOverlap: perRule.reduce((sum, r) => sum + r.matched, 0) !== excludedTotal,
  };
}

/** Parses and validates the `lead_exclusion` config row. */
export function parseLeadExclusion(value: unknown): LeadExclusionConfig {
  if (value == null) return NO_LEAD_EXCLUSION;
  const raw = value as Partial<LeadExclusionConfig>;
  if (typeof raw.enabled !== 'boolean') {
    throw new LeadExclusionConfigError('`enabled` must be present and boolean.');
  }
  const rules = raw.rules ?? [];
  const config: LeadExclusionConfig = {
    enabled: raw.enabled,
    rules,
    inboundSignalFields: raw.inboundSignalFields ?? [],
  };

  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.key) throw new LeadExclusionConfigError('every rule needs a `key`.');
    if (seen.has(rule.key)) {
      throw new LeadExclusionConfigError(`duplicate rule key "${rule.key}".`);
    }
    seen.add(rule.key);
    // Throws on an empty rule, here rather than at query time.
    ruleClause(rule);
  }

  if (config.enabled && config.inboundSignalFields.length === 0) {
    throw new LeadExclusionConfigError(
      'no `inboundSignalFields`. Without at least one, nothing can be positively ' +
        'classified as inbound and every unmatched lead would be ingested on the ' +
        'assumption that it is — which is the failure this exclusion exists to prevent.',
    );
  }

  return config;
}

/**
 * The rule a stored lead falls under by its Lead Source alone, or null.
 *
 * For a rule added after leads were ingested: the sync never reads those leads
 * again, so the ones already stored are marked excluded by this instead of
 * lingering as inbound. Only a rule whose sole criterion is `leadSources` can
 * be applied from the stored value.
 */
export function leadSourceExclusion(config: LeadExclusionConfig, leadSource: string | null): LeadExclusionRule | null {
  if (!config.enabled || leadSource === null) return null;
  return (
    config.rules.find(
      (r) =>
        r.leadSources?.includes(leadSource) &&
        !r.ownerNames?.length &&
        !r.ownerIds?.length &&
        !r.createdBetween &&
        !r.requireNullLeadSource,
    ) ?? null
  );
}
