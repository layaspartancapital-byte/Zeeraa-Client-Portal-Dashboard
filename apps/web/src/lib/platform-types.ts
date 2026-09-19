/**
 * The campaign-type breakdown, as a pure rule.
 *
 * Its own module so it can be unit-tested: everything else in `platform.ts`
 * reaches the database, which reaches the session, which reaches next-auth —
 * and a test of a merge should not need any of that.
 */

export type CampaignTypeRow = {
  /** The platform's own value, verbatim: `SEARCH`, `OUTCOME_LEADS`… */
  key: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Campaigns of this type that reported anything in the window. */
  delivering: number;
  /**
   * Campaigns of this type the account holds at all.
   *
   * Both counts, because a type with campaigns and no delivery has to appear.
   * Dropping it would answer "how did Performance Max do" with silence, and a
   * reader cannot tell silence from "we do not run it" — which are the two
   * answers they are actually choosing between.
   */
  configured: number;
};

const n = (v: unknown): number => Number(v ?? 0);

/**
 * Delivery joined to the account's configured types.
 *
 * Sorted by spend, then by how many campaigns exist — so the types that ran sit
 * at the top and the ones that did not still appear, in a stable order rather
 * than whichever the planner happened to emit.
 */
export function mergeTypes(
  delivered: { key: string | null; spend: string; impressions: string; clicks: string; conversions: string; delivering: number }[],
  configured: { key: string | null; configured: number }[],
): CampaignTypeRow[] {
  const keys = new Set<string | null>([
    ...delivered.map((r) => r.key),
    ...configured.map((r) => r.key),
  ]);
  return [...keys]
    .map((key) => {
      const d = delivered.find((r) => r.key === key);
      const c = configured.find((r) => r.key === key);
      return {
        key,
        spend: n(d?.spend),
        impressions: n(d?.impressions),
        clicks: n(d?.clicks),
        conversions: n(d?.conversions),
        delivering: Number(d?.delivering ?? 0),
        configured: Number(c?.configured ?? 0),
      };
    })
    .sort((a, b) => b.spend - a.spend || b.configured - a.configured);
}
