/**
 * Tenant context is transaction-local, which only works if every path that
 * carries it opens a real transaction.
 *
 * `set_config(key, value, true)` applies to the current transaction and is
 * discarded at COMMIT. If any query path ran outside a transaction the setting
 * would either fail to apply, or — far worse under a connection pool — persist
 * on the connection and be inherited by whatever request picked it up next.
 *
 * These tests use a pool of exactly one connection, so every statement is
 * guaranteed to reuse the same backend. That is the condition under which a
 * leak would actually show up; a larger pool can hide it by luck.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/schema';
import { withTenant, withUserOnly } from '../src/tenant-context';
import { APP_URL, cleanup, ownerClient, seedTwoTenants, type Fixture } from './fixtures';

const owner = ownerClient();
// One connection: every statement below lands on the same backend.
const single = postgres(APP_URL, { max: 1, prepare: false, onnotice: () => {} });
const singleDb = drizzle(single, { schema });
let fx: Fixture;

const currentTenant = sql`select coalesce(current_setting('app.current_tenant_id', true), '') as v`;

beforeAll(async () => {
  fx = await seedTwoTenants(owner.db);
});

afterAll(async () => {
  await cleanup(owner.db, fx);
  await Promise.all([owner.client.end(), single.end()]);
});

describe('withTenant', () => {
  it('opens one real transaction spanning every statement in the callback', async () => {
    // Two calls to txid_current() return the same id only inside one explicit
    // transaction. In autocommit each statement gets its own.
    const [first, second] = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      async (tx) => {
        const a = await tx.execute<{ id: string }>(sql`select txid_current()::text as id`);
        const b = await tx.execute<{ id: string }>(sql`select txid_current()::text as id`);
        return [a[0]?.id, b[0]?.id];
      },
      singleDb,
    );
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('keeps the context across separate statements inside the callback', async () => {
    const seen = await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      async (tx) => {
        await tx.execute(sql`select 1`);
        const rows = await tx.execute<{ v: string }>(currentTenant);
        return rows[0]?.v;
      },
      singleDb,
    );
    expect(seen).toBe(fx.tenantA);
  });

  it('leaves nothing behind on the connection it used', async () => {
    await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      (tx) => tx.select().from(schema.opportunities),
      singleDb,
    );
    // Same backend, next caller. This is the leak that a session-level SET
    // would produce, and the reason set_config is transaction-scoped.
    const after = await singleDb.execute<{ v: string }>(currentTenant);
    expect(after[0]?.v).toBe('');

    const rows = await singleDb.select().from(schema.opportunities);
    expect(rows).toHaveLength(0);
  });

  it('discards the context when the transaction rolls back', async () => {
    await withTenant(
      { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
      async () => {
        throw new Error('deliberate');
      },
      singleDb,
    ).catch(() => undefined);

    const after = await singleDb.execute<{ v: string }>(currentTenant);
    expect(after[0]?.v).toBe('');
  });

  it('does not extend to queries issued on the outer handle', async () => {
    // The mistake this guards against: writing a query against the pool instead
    // of against the transaction handle passed into the callback. That query
    // takes a different connection, which carries no context, so it reads
    // nothing — never the whole table.
    //
    // Needs its own pool. On a single-connection pool the same mistake blocks
    // forever instead, waiting for the connection its own transaction is
    // holding. Both outcomes are safe; neither is a leak.
    const pool = postgres(APP_URL, { max: 4, prepare: false, onnotice: () => {} });
    const poolDb = drizzle(pool, { schema });
    try {
      const outer = await withTenant(
        { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' },
        () => poolDb.select().from(schema.opportunities),
        poolDb,
      );
      expect(outer).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it('keeps concurrent tenants apart', async () => {
    const pool = postgres(APP_URL, { max: 4, prepare: false, onnotice: () => {} });
    const poolDb = drizzle(pool, { schema });
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => {
          const useA = i % 2 === 0;
          return withTenant(
            useA
              ? { tenantId: fx.tenantA, userId: fx.clientAdminA, role: 'client_admin' }
              : { tenantId: fx.tenantB, userId: fx.clientViewerB, role: 'client_viewer' },
            (tx) => tx.select().from(schema.opportunities),
            poolDb,
          ).then((rows) => ({ useA, ids: rows.map((r) => r.externalId) }));
        }),
      );
      for (const { useA, ids } of results) {
        expect(ids).toEqual([useA ? 'A-OPP-1' : 'B-OPP-1']);
      }
    } finally {
      await pool.end();
    }
  });
});

describe('withUserOnly', () => {
  it('also runs in a transaction and leaves nothing behind', async () => {
    const same = await withUserOnly(
      fx.zeeraaAdmin,
      async (tx) => {
        const a = await tx.execute<{ id: string }>(sql`select txid_current()::text as id`);
        const b = await tx.execute<{ id: string }>(sql`select txid_current()::text as id`);
        return a[0]?.id === b[0]?.id;
      },
      singleDb,
    );
    expect(same).toBe(true);

    const after = await singleDb.execute<{ v: string }>(
      sql`select coalesce(current_setting('app.current_user_id', true), '') as v`,
    );
    expect(after[0]?.v).toBe('');
  });
});
