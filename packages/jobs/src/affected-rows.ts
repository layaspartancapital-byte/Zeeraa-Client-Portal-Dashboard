/**
 * Rows a write touched, from postgres.js's command tag (`INSERT 0 1126`).
 *
 * The high-volume writers used `RETURNING id` and counted the array: every
 * row's id travelled back over the wire only to be counted — Search Console's
 * 16,800 rows an hour alone were about 0.6 GB a month of Neon's metered
 * network transfer (30 October 2026). The tag carries the same count, inserts
 * and conflict updates alike, and costs nothing.
 */
export function affectedRows(result: unknown): number {
  return Number((result as { count?: number | null } | null)?.count ?? 0);
}
