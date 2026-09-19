/**
 * What "delivered" means, as named functions rather than as arithmetic spread
 * across the delivery screen, the CSV export and the writer that maintains the
 * derived records.
 *
 * Three rules live here, and each one exists because the obvious alternative is
 * wrong:
 *
 * 1. **Nothing recorded is not zero delivered.** A commitment with no artifact
 *    and no hand-recorded count has no delivered figure at all, and every
 *    caller has to handle that as an absence. `resolveDelivered` returns null
 *    rather than 0, so a component cannot render the wrong one by accident.
 * 2. **A superseded artifact is not a second delivery.** Version 2 of an
 *    article replaces version 1; counting both would report two articles where
 *    the client received one.
 * 3. **Approved artifacts and a hand-recorded count are alternatives, never
 *    addends.** Adding them double-counts the moment somebody uploads the work
 *    they had already tallied.
 */

import type { DateRange } from './dates';

export type CommitmentPeriod = 'monthly' | 'quarterly';

/**
 * The asset statuses that stand behind a delivered count.
 *
 * `published` is included because it is what an approved asset becomes when it
 * goes live; excluding it would make a delivered figure fall as work shipped.
 * Nothing before approval counts: a submitted asset is a request for a
 * decision, and counting it would let Zeeraa raise its own delivered figure.
 */
export const DELIVERED_ASSET_STATUSES = ['approved', 'published'] as const;
export type DeliveredAssetStatus = (typeof DELIVERED_ASSET_STATUSES)[number];

/** The statuses that mean an artifact exists and is no longer Zeeraa-internal. */
export const SUBMITTED_ASSET_STATUSES = [
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'published',
] as const;

export type CountableAsset = {
  id: string;
  status: string;
  /**
   * The id of the asset that replaces this one, where one does. Derived from
   * the version chain rather than stored on the row it supersedes, so the two
   * cannot disagree.
   */
  supersededByAssetId?: string | null;
};

export function isSubmitted(asset: CountableAsset): boolean {
  return (SUBMITTED_ASSET_STATUSES as readonly string[]).includes(asset.status);
}

/**
 * One artifact counts once, in its latest version, and only once a client has
 * approved it.
 */
export function countsAsDelivered(asset: CountableAsset): boolean {
  if (asset.supersededByAssetId) return false;
  return (DELIVERED_ASSET_STATUSES as readonly string[]).includes(asset.status);
}

export function deliveredAssetIds(assets: readonly CountableAsset[]): string[] {
  return assets.filter(countsAsDelivered).map((a) => a.id);
}

/**
 * Whether a derived record should exist for this commitment and period at all.
 *
 * It should once an artifact has been put in front of the client, and not
 * before. A draft sitting in Zeeraa's own column is work in progress; writing a
 * record for it would turn "we have started" into a delivered figure of zero,
 * which reads as a failure to deliver rather than as nothing to report yet.
 */
export function hasCountableArtifacts(assets: readonly CountableAsset[]): boolean {
  return assets.some((a) => isSubmitted(a) && !a.supersededByAssetId);
}

export type DeliveredFigure = {
  quantity: number;
  source: 'manual' | 'derived_from_assets';
  /**
   * The hand-recorded count, where one exists alongside artifacts and differs
   * from them. Not added to the figure — stated beside it, because a tally of
   * 20 behind 12 approved artifacts is a discrepancy the client should see
   * rather than a number to reconcile silently.
   */
  recordedByHand: number | null;
};

/**
 * The delivered figure for one commitment in one period, or null where nothing
 * has been recorded.
 *
 * Artifacts win where they exist. The hand-recorded count is for the
 * commitments that produce no artifact at all — backlinks, tracked GEO
 * prompts, concurrent A/B tests — and using it in preference to approved work
 * would be measuring data entry, which this product has already retired one
 * metric for.
 */
export function resolveDelivered(input: {
  /** Count of approved, unsuperseded artifacts, or null where none are tagged. */
  derived: number | null;
  /** A hand-recorded count for the period, or null where none was written. */
  manual: number | null;
}): DeliveredFigure | null {
  if (input.derived !== null) {
    return {
      quantity: input.derived,
      source: 'derived_from_assets',
      recordedByHand:
        input.manual !== null && input.manual !== input.derived ? input.manual : null,
    };
  }
  if (input.manual !== null) {
    return { quantity: input.manual, source: 'manual', recordedByHand: null };
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Periods                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The first day of the period a tenant-local day falls in.
 *
 * `day` is already normalised into the tenant's timezone — dates are converted
 * at ingest, never here — so this is string arithmetic and carries no
 * boundary error of its own.
 */
export function commitmentPeriodStart(period: CommitmentPeriod, day: string): string {
  if (period === 'quarterly') {
    const month = Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1;
    return `${day.slice(0, 4)}-${String(month).padStart(2, '0')}-01`;
  }
  return `${day.slice(0, 7)}-01`;
}

/** The half-open range a commitment period covers, as tenant-local days. */
export function commitmentPeriodRange(period: CommitmentPeriod, day: string): DateRange {
  const start = commitmentPeriodStart(period, day);
  const months = period === 'quarterly' ? 3 : 1;
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7)) - 1 + months;
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end: end.toISOString().slice(0, 10) };
}

export function commitmentPeriodLabel(period: CommitmentPeriod, periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  if (period === 'quarterly') {
    const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
    return `Q${quarter} ${date.getUTCFullYear()}`;
  }
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/* ------------------------------------------------------------------------- */
/* Object keys                                                                */
/* ------------------------------------------------------------------------- */

/**
 * A client's creative is not public, and the key is the first line of that.
 *
 * Every object lives under `tenant/{tenant_id}/`, which is also the only prefix
 * the application's IAM policy can reach — so a bug that built a key outside it
 * fails at the storage layer rather than writing one client's artwork somewhere
 * another client's signed URL could reach. The version is in the path because
 * old versions are never deleted.
 */
export function assetObjectKey(input: {
  tenantId: string;
  assetId: string;
  version: number;
  fileName: string;
}): string {
  return [
    'tenant',
    input.tenantId,
    'assets',
    input.assetId,
    `v${input.version}`,
    safeFileName(input.fileName),
  ].join('/');
}

export function isTenantScopedKey(key: string, tenantId: string): boolean {
  return key.startsWith(`tenant/${tenantId}/`);
}

/**
 * A file name that survives being put in a URL path and cannot climb out of its
 * prefix. Names arrive from a file picker on somebody's desktop, so they carry
 * spaces, slashes, quotes and occasionally a path.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}
