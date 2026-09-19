/**
 * The version chain, at the level of the SQL that reads it.
 *
 * The arithmetic is unit-tested in `@zeeraa/core`; what this file guards is the
 * one thing those tests cannot see. The correlated subquery that asks "is there
 * a later version of this row" compiles, runs and returns a boolean either way.
 * If the outer column is rendered unqualified it binds to the *inner* alias,
 * the condition becomes `later.supersedes_asset_id = later.id`, every row comes
 * back `false`, and superseded versions silently stop being excluded from
 * delivered counts. No error, no failed query, just a delivered figure that
 * counts one article twice.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { supersededByLaterVersion, supersedingAssetId } from '../src/lib/asset-sql';

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof sql>) => dialect.sqlToQuery(fragment).sql;

describe('the version-chain subqueries', () => {
  it.each([
    ['supersededByLaterVersion', supersededByLaterVersion],
    ['supersedingAssetId', supersedingAssetId],
  ])('%s correlates against the outer row, not the inner alias', (_name, fragment) => {
    const text = render(fragment);
    expect(text).toContain('"assets"."id"');
    expect(text).not.toMatch(/=\s*"id"/);
  });

  it('gives the inner scan its own alias', () => {
    expect(render(supersededByLaterVersion)).toMatch(/from "assets" later/);
  });
});
