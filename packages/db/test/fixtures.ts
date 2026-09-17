import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/schema/index';

export const OWNER_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/zeeraa';
export const APP_URL =
  process.env.DATABASE_URL_APP ?? 'postgres://zeeraa_app:zeeraa_app@localhost:5433/zeeraa';

export function ownerClient() {
  const client = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

export function appClient() {
  const client = postgres(APP_URL, { max: 2, prepare: false, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

export type Fixture = {
  tenantA: string;
  tenantB: string;
  zeeraaAdmin: string;
  clientAdminA: string;
  clientViewerB: string;
};

/**
 * Two tenants that must never see each other, with the four roles spread across
 * them. Written with the owner connection so that the seeding itself is not the
 * thing under test.
 */
export async function seedTwoTenants(db: ReturnType<typeof ownerClient>['db']): Promise<Fixture> {
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
  const [clientA] = await db
    .insert(schema.users)
    .values({ email: `a-admin-${stamp}@example.test`, name: 'Client A Admin' })
    .returning();
  const [clientB] = await db
    .insert(schema.users)
    .values({ email: `b-viewer-${stamp}@example.test`, name: 'Client B Viewer' })
    .returning();
  if (!admin || !clientA || !clientB) throw new Error('user insert failed');

  await db.insert(schema.memberships).values([
    { userId: admin.id, tenantId: a.id, role: 'zeeraa_admin' },
    { userId: admin.id, tenantId: b.id, role: 'zeeraa_admin' },
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

  return {
    tenantA: a.id,
    tenantB: b.id,
    zeeraaAdmin: admin.id,
    clientAdminA: clientA.id,
    clientViewerB: clientB.id,
  };
}

export async function cleanup(db: ReturnType<typeof ownerClient>['db'], fx: Fixture) {
  await db.execute(sql`delete from tenants where id in (${fx.tenantA}, ${fx.tenantB})`);
  await db.execute(
    sql`delete from users where id in (${fx.zeeraaAdmin}, ${fx.clientAdminA}, ${fx.clientViewerB})`,
  );
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
