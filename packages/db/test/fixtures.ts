import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/schema/index';
import { withMaintenance } from '../src/tenant-context';
import type { Database } from '../src/client';

/**
 * Refuses to run the suite against anything but a local database.
 *
 * This suite is not read-only. It seeds two tenants and four users, writes
 * opportunities, spend, submissions and calls, and deletes all of it again in
 * `cleanup`; `scripts/mutation-test.ts` goes further and drops the schema it
 * points at. Pointed at Neon it would be writing to the production database.
 *
 * The failure it exists to catch is not a typo. `.env` used to define
 * `DATABASE_URL_JOBS` and `DATABASE_URL_MAINT` twice — local first, Neon
 * second — so sourcing the whole file before `pnpm test` sent the ingestion and
 * maintenance roles to production while the owner seeded locally. The
 * duplicates are gone and the production strings are in `.env.neon` now, but
 * that file exports the same variable names by design, and an export outlives
 * the command it was sourced for.
 *
 * Every `DATABASE_URL*` in the environment is checked, not only the four this
 * file reads: `job-role.test.ts` builds its own from `DATABASE_URL_JOBS` and
 * `organic-isolation.test.ts` reaches it through `getJobsDb()`, and both would
 * otherwise slip past. A URL that cannot be parsed is treated as remote —
 * failing closed is the whole point.
 *
 * CI is covered: its Postgres is a service container on `localhost:5432`.
 * `ALLOW_REMOTE_TEST_DATABASE=yes` is the deliberate escape hatch for a
 * throwaway remote branch, and typing it is a different act from forgetting a
 * `source`.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // Passwords arrive with characters `URL` will not take. Fall back to the
    // authority between the last `@` and the next `/`, `:` or `?`.
    return /@([^/:?]+)/.exec(url)?.[1] ?? null;
  }
}

function assertLocalDatabases(): void {
  if (process.env.ALLOW_REMOTE_TEST_DATABASE === 'yes') return;

  const remote = Object.entries(process.env)
    .filter(([key, value]) => key.startsWith('DATABASE_URL') && value)
    .map(([key, value]) => [key, hostOf(value as string)] as const)
    .filter(([, host]) => host === null || !LOCAL_HOSTS.has(host));

  if (remote.length === 0) return;

  throw new Error(
    'Refusing to run the isolation suite against a non-local database. This ' +
      'suite writes and deletes rows.\n' +
      remote.map(([key, host]) => `  ${key} → ${host ?? '<unparseable>'}`).join('\n') +
      '\n\nThis usually means `.env.neon` was sourced in this shell. Open a new ' +
      'one, or set ALLOW_REMOTE_TEST_DATABASE=yes if the target really is ' +
      'disposable.',
  );
}

assertLocalDatabases();

export const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
export const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/zeeraa';
export const APP_URL =
  process.env.DATABASE_URL_APP ?? 'postgres://zeeraa_app:zeeraa_app@localhost:5433/zeeraa';
/** The role a backfill script or a psql session should use. */
export const MAINT_URL =
  process.env.DATABASE_URL_MAINT ?? 'postgres://zeeraa_maint:zeeraa_maint@localhost:5433/zeeraa';

export function ownerClient(): { client: postgres.Sql; db: Database } {
  const client = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

/**
 * The administrative superuser connection. Used only to prove that the startup
 * guard rejects a connection that can bypass row level security — `zeeraa_owner`
 * no longer can, which is the point of it.
 */
export function adminClient(): { client: postgres.Sql; db: Database } {
  const client = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

export function maintClient(): { client: postgres.Sql; db: Database } {
  const client = postgres(MAINT_URL, { max: 1, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

export function appClient(): { client: postgres.Sql; db: Database } {
  const client = postgres(APP_URL, { max: 2, prepare: false, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

export type Fixture = {
  tenantA: string;
  tenantB: string;
  zeeraaAdmin: string;
  /** A Zeeraa admin with a membership row in tenant A only. */
  zeeraaAdminAOnly: string;
  clientAdminA: string;
  clientViewerB: string;
};

/**
 * Two tenants that must never see each other, with the four roles spread across
 * them. Written with the owner connection so that the seeding itself is not the
 * thing under test.
 */
export async function seedTwoTenants(db: Database): Promise<Fixture> {
  return withMaintenance(db, (tx) => seedTwoTenantsInner(tx));
}

async function seedTwoTenantsInner(db: Database): Promise<Fixture> {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);

  const [a] = await db
    .insert(schema.tenants)
    .values({ name: 'Tenant A', slug: `a-${stamp}`, accentColor: '#2F5D8C' })
    .returning();
  const [b] = await db
    .insert(schema.tenants)
    .values({ name: 'Tenant B', slug: `b-${stamp}`, accentColor: '#6B2F5D' })
    .returning();
  if (!a || !b) throw new Error('tenant insert failed');

  const [admin] = await db
    .insert(schema.users)
    .values({ email: `zeeraa-${stamp}@example.test`, name: 'Zeeraa Admin' })
    .returning();
  const [adminAOnly] = await db
    .insert(schema.users)
    .values({ email: `zeeraa-a-${stamp}@example.test`, name: 'Zeeraa Admin (tenant A only)' })
    .returning();
  const [clientA] = await db
    .insert(schema.users)
    .values({ email: `a-admin-${stamp}@example.test`, name: 'Client A Admin' })
    .returning();
  const [clientB] = await db
    .insert(schema.users)
    .values({ email: `b-viewer-${stamp}@example.test`, name: 'Client B Viewer' })
    .returning();
  if (!admin || !adminAOnly || !clientA || !clientB) throw new Error('user insert failed');

  await db.insert(schema.memberships).values([
    { userId: admin.id, tenantId: a.id, role: 'zeeraa_admin' },
    { userId: admin.id, tenantId: b.id, role: 'zeeraa_admin' },
    // Deliberately no membership in tenant B.
    { userId: adminAOnly.id, tenantId: a.id, role: 'zeeraa_admin' },
    { userId: clientA.id, tenantId: a.id, role: 'client_admin' },
    { userId: clientB.id, tenantId: b.id, role: 'client_viewer' },
  ]);

  // One identifiable row per tenant in a table that would hurt to leak.
  await db.insert(schema.opportunities).values([
    {
      tenantId: a.id,
      externalId: 'A-OPP-1',
      createdAt: new Date('2026-08-01T12:00:00Z'),
      currentStage: 'funded',
      fundedAmount: '250000.00',
    },
    {
      tenantId: b.id,
      externalId: 'B-OPP-1',
      createdAt: new Date('2026-08-01T12:00:00Z'),
      currentStage: 'funded',
      fundedAmount: '980000.00',
    },
  ]);

  await db.insert(schema.dailyMetrics).values([
    { tenantId: a.id, platform: 'google_ads', date: '2026-08-01', spend: '1000.0000' },
    { tenantId: b.id, platform: 'google_ads', date: '2026-08-01', spend: '9999.0000' },
  ]);

  // A submission names a third party's decision about a client's merchant, so
  // a leak here is commercially sensitive in a way a spend figure is not:
  // tenant A would learn which lenders tenant B uses and what they decline.
  await db.insert(schema.submissions).values([
    {
      tenantId: a.id,
      externalId: 'A-SUB-1',
      opportunityExternalId: 'A-OPP-1',
      lenderName: 'Lender A',
      status: 'Declined',
      outcome: 'declined',
      declineReasons: ['Bankruptcy'],
      submittedAt: new Date('2026-08-01T12:00:00Z'),
    },
    {
      tenantId: b.id,
      externalId: 'B-SUB-1',
      opportunityExternalId: 'B-OPP-1',
      lenderName: 'Lender B',
      status: 'Offer(s) Received',
      outcome: 'offered',
      submittedAt: new Date('2026-08-01T12:00:00Z'),
    },
  ]);

  // A call carries a merchant's phone number and an agent's name. Leaking one
  // tenant's calls to another exposes both, plus who the other client is
  // calling and how often.
  await db.insert(schema.calls).values([
    {
      tenantId: a.id,
      externalId: 'A-CALL-1',
      occurredAt: new Date('2026-08-01T12:00:00Z'),
      direction: 'outbound',
      outcome: 'connected',
      contactNumber: '(312) 555-0111',
      contactKey: '3125550111',
      agentName: 'Rep A',
      source: 'csv_import',
    },
    {
      tenantId: b.id,
      externalId: 'B-CALL-1',
      occurredAt: new Date('2026-08-01T12:00:00Z'),
      direction: 'outbound',
      outcome: 'connected',
      contactNumber: '(415) 555-0222',
      contactKey: '4155550222',
      agentName: 'Rep B',
      source: 'csv_import',
    },
  ]);

  return {
    tenantA: a.id,
    tenantB: b.id,
    zeeraaAdmin: admin.id,
    zeeraaAdminAOnly: adminAOnly.id,
    clientAdminA: clientA.id,
    clientViewerB: clientB.id,
  };
}

export async function cleanup(db: Database, fx: Fixture) {
  await withMaintenance(db, async (tx) => {
    await tx.execute(sql`delete from tenants where id in (${fx.tenantA}, ${fx.tenantB})`);
    await tx.execute(
      sql`delete from users where id in (${fx.zeeraaAdmin}, ${fx.zeeraaAdminAOnly}, ${fx.clientAdminA}, ${fx.clientViewerB})`,
    );
  });
}

/** Owner-side verification reads. Explicit about crossing the tenant boundary. */
export function asOwner<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withMaintenance(db, fn);
}

type PgFailure = { code?: string; message: string };

/**
 * Drizzle wraps driver errors, so the Postgres error sits on `cause`. Tests
 * assert on SQLSTATE rather than on message text: `42501` is an RLS refusal and
 * `23514` the membership-cardinality trigger, and neither changes wording
 * between Postgres releases.
 */
export function pgError(error: unknown): PgFailure {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  return {
    code: (cause as { code?: string })?.code,
    message: String((cause as { message?: string })?.message ?? cause),
  };
}

export async function failure(fn: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await fn();
  } catch (error) {
    return pgError(error);
  }
  throw new Error('Expected the database to reject this statement, but it succeeded.');
}
