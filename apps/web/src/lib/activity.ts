import 'server-only';
import { sql } from 'drizzle-orm';
import { platformLabel } from '@zeeraa/core';
import { schema } from '@zeeraa/db';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * When somebody was last seen in a tenant, and on which page (migration 0040).
 *
 * Written from `ActivityBeacon` when the pathname changes — never on the
 * ten-minute `AutoRefresh`, which would make an unattended tab read as a person
 * online all day. At most once a minute per person: the beacon holds a later
 * page until the minute is up, and the upsert below refuses anything sooner, so
 * two tabs cannot double it. Each write follows a page view that has already
 * woken the database; it never wakes it on its own.
 */

/** Seen within this long reads as online. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** The shortest gap between two writes for one person in one tenant. */
export const ACTIVITY_INTERVAL_MS = 60 * 1000;

const MAX_PATH = 300;

/** A pathname inside this tenant, or null for anything else. */
export function activityPath(slug: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_PATH) return null;
  const path = raw.split(/[?#]/)[0]!;
  const root = `/${slug}`;
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  return path;
}

export async function recordActivity(session: TenantSession, raw: unknown): Promise<void> {
  const path = activityPath(session.tenant.slug, raw);
  if (!path) return;
  await queryTenant(session, (tx) =>
    tx
      .insert(schema.userActivity)
      .values({ tenantId: session.tenant.id, userId: session.viewer.userId, lastPath: path })
      .onConflictDoUpdate({
        target: [schema.userActivity.tenantId, schema.userActivity.userId],
        set: { lastSeenAt: sql`now()`, lastPath: path },
        setWhere: sql`${schema.userActivity.lastSeenAt} < now() - make_interval(secs => ${
          ACTIVITY_INTERVAL_MS / 1000
        })`,
      }),
  );
}

const PAGES: Record<string, string> = {
  '': 'Executive',
  performance: 'Monthly performance',
  funnel: 'Funnel',
  people: 'People',
  connections: 'Connections',
  admin: 'Reconciliation',
};

/** The page a stored path names, as the rail labels it. */
export function pageLabel(slug: string, path: string): string {
  const rest = path.slice(slug.length + 1).replace(/^\/|\/$/g, '');
  const [first = '', second] = rest.split('/');
  if (first === 'platforms' && second) return platformLabel(second);
  return PAGES[first] ?? `/${rest}`;
}
