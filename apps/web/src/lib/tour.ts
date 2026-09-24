import { and, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * The first-login product tour's completion, per user (migration 0033).
 *
 * In the database rather than the browser, so a tour finished on a laptop does
 * not run again on a phone. Versioned: raise `TOUR_VERSION` when the steps
 * change enough that everybody should see them again, and every user is shown
 * the new tour once. The row is the user's own — `own_tours` admits nobody
 * else, so this runs inside the ordinary tenant context and needs no role.
 */
export const TOUR_KEY = 'first-login';
export const TOUR_VERSION = 1;

export async function hasCompletedTour(session: TenantSession): Promise<boolean> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select({ at: schema.productTours.completedAt })
      .from(schema.productTours)
      .where(
        and(
          eq(schema.productTours.userId, session.viewer.userId),
          eq(schema.productTours.tour, TOUR_KEY),
          eq(schema.productTours.version, TOUR_VERSION),
        ),
      ),
  );
  return rows.length > 0;
}

/** Finished or skipped: both mean "do not start this again on its own". */
export async function recordTourCompleted(session: TenantSession): Promise<void> {
  await queryTenant(session, (tx) =>
    tx
      .insert(schema.productTours)
      .values({ userId: session.viewer.userId, tour: TOUR_KEY, version: TOUR_VERSION })
      .onConflictDoUpdate({
        target: [schema.productTours.userId, schema.productTours.tour, schema.productTours.version],
        set: { completedAt: new Date() },
      }),
  );
}
