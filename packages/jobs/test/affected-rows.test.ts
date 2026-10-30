import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { getJobsDb } from '@zeeraa/db';
import { affectedRows } from '../src/affected-rows';

/**
 * The writers count what they wrote from the command tag instead of
 * `RETURNING id` (30 October 2026). The count must be the one `RETURNING`
 * gave: inserted and conflict-updated rows alike, through raw SQL and the
 * query builder. A temporary table, so nothing here touches tenant data.
 */
const scratch = pgTable('affected_rows_scratch', { id: integer('id').primaryKey(), v: integer('v') });

describe('affectedRows', () => {
  it('counts inserts and conflict updates as RETURNING did', async () => {
    await getJobsDb().transaction(async (tx) => {
      await tx.execute(sql`create temp table affected_rows_scratch (id int primary key, v int) on commit drop`);
      expect(affectedRows(await tx.execute(sql`insert into affected_rows_scratch values (1, 1), (2, 2)`))).toBe(2);
      expect(
        affectedRows(
          await tx.execute(sql`insert into affected_rows_scratch values (2, 3), (3, 3), (4, 4)
            on conflict (id) do update set v = excluded.v`),
        ),
      ).toBe(3);
      const built = await tx
        .insert(scratch)
        .values([{ id: 4, v: 5 }, { id: 5, v: 5 }])
        .onConflictDoUpdate({ target: scratch.id, set: { v: sql`excluded.v` } });
      expect(affectedRows(built)).toBe(2);
      expect(affectedRows(await tx.execute(sql`update affected_rows_scratch set v = 0 where id > 100`))).toBe(0);
    });
  });
});
