import { sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';

/**
 * The version chain, as SQL, written once.
 *
 * Only the latest version of a piece of work counts toward a delivered figure,
 * and "latest" is read from the chain — a row does not record that it has been
 * retired, the row that retires it records what it replaces. So every query
 * that counts assets has to ask whether a later version exists.
 *
 * **The outer column is spelled out as `"assets"."id"` deliberately.** Drizzle
 * renders an interpolated column reference *unqualified* in a select list, and
 * an unqualified `id` inside this subquery binds to the inner alias instead of
 * the outer row — making the condition `later.supersedes_asset_id = later.id`,
 * which a check constraint guarantees is never true. The query still runs and
 * still returns a boolean for every row; it is just always false, so superseded
 * versions quietly stop being excluded and an article approved at v1 and again
 * at v2 counts as two articles delivered. There is no error to notice, which is
 * why this is a named constant with a test on its generated SQL rather than an
 * expression repeated at three call sites.
 */
const outerAssetId = sql`${sql.identifier('assets')}.${sql.identifier('id')}`;

export const supersededByLaterVersion = sql<boolean>`exists (
  select 1 from ${schema.assets} later
  where later.supersedes_asset_id = ${outerAssetId}
)`;

export const supersedingAssetId = sql<string | null>`(
  select later.id from ${schema.assets} later
  where later.supersedes_asset_id = ${outerAssetId}
  limit 1
)`;
