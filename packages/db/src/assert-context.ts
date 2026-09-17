import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

let verified = false;

/**
 * Proves that transaction-local settings actually survive between statements on
 * the configured connection, and are gone once the transaction ends.
 *
 * Tenant isolation rests entirely on this. `withTenant` sets the tenant with
 * `set_config(..., true)` and every policy reads it back in a later statement.
 * Behind a pooler in `statement` mode those statements can land on different
 * backends: the setting evaporates, `app.current_tenant_id()` is null, and
 * every policy evaluates to false. That fails closed — but it fails closed by
 * returning nothing for everybody, which looks like a broken product and gets
 * "fixed" under time pressure by someone loosening a policy.
 *
 * The opposite misconfiguration is worse. If the context were ever to persist
 * past COMMIT on a pooled connection, the next request to pick that connection
 * up would inherit another client's tenant.
 *
 * So this runs both directions as a real probe against the real connection
 * string, and refuses to serve if either is wrong. A DATABASE_URL_APP pointed
 * at a statement-mode pooler should break the deploy, not quietly disable
 * tenant isolation in production.
 *
 * Uses its own single-connection client so the post-commit read is guaranteed
 * to land on the connection that ran the transaction. Read against the shared
 * pool it could get a different backend and pass for the wrong reason.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * A startup check has to finish. Against a statement-mode pooler the driver
 * does not get a clean refusal it can report — PgBouncer closes the connection
 * on BEGIN and postgres.js reconnects and tries again, indefinitely. A deploy
 * that hangs is worse than one that fails, so the probe races a deadline.
 */
function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function assertTransactionLocalContext(url?: string): Promise<void> {
  if (!url && verified) return;

  const target = url ?? process.env.DATABASE_URL_APP;
  if (!target) throw new Error('DATABASE_URL_APP is not set.');

  const probe = randomUUID();
  const client = postgres(target, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    // A statement-mode pooler does not answer — PgBouncer closes the connection
    // the moment it sees BEGIN. Without a timeout this check hangs, and a
    // deploy that hangs is harder to diagnose than one that fails.
    connect_timeout: 10,
  });

  try {
    let carried: string;
    try {
      carried = await withDeadline(
        client.begin(async (tx) => {
        await tx`select set_config('app.context_probe', ${probe}, true)`;
        // Deliberately a second round trip. One statement would prove nothing:
        // the question is whether the two share a transaction.
        const [row] = await tx<{ v: string }[]>`
          select coalesce(current_setting('app.context_probe', true), '') as v
        `;
          return row?.v ?? '';
        }) as Promise<string>,
        'Transaction probe',
      );
    } catch (error) {
      // PgBouncer's statement mode refuses the transaction outright rather than
      // silently splitting it: "transaction blocks not allowed in statement
      // pooling mode", which reaches the driver as a closed connection.
      throw new Error(
        'Refusing to start: could not open a transaction on this connection. ' +
          'Tenant context is set per transaction, so without one row level ' +
          'security has nothing to read. A connection pooler in statement mode ' +
          'rejects transactions outright — use transaction mode (Neon\u2019s ' +
          'pooled endpoint, or PgBouncer pool_mode = transaction). ' +
          `Underlying error: ${(error as Error).message}`,
        { cause: error },
      );
    }

    if (carried !== probe) {
      throw new Error(
        'Refusing to start: transaction-local settings did not survive between ' +
          'statements on this connection. Tenant context is carried this way, so ' +
          'row level security would evaluate against a null tenant and every ' +
          'query would return nothing. The usual cause is a connection pooler in ' +
          'statement mode — use transaction mode (Neon’s pooled endpoint, or ' +
          'PgBouncer pool_mode = transaction).',
      );
    }

    const [after] = await withDeadline(
      client<{ v: string }[]>`
        select coalesce(current_setting('app.context_probe', true), '') as v
      `,
      'Post-commit probe',
    );

    if (after?.v) {
      throw new Error(
        'Refusing to start: a transaction-local setting outlived its transaction ' +
          'on this connection. Tenant context would leak from one request to the ' +
          'next through the connection pool. Check that withTenant uses ' +
          'set_config(..., true) and that nothing issues a session-level SET.',
      );
    }
  } finally {
    // The connection may already be gone; do not let cleanup hang either.
    await client.end({ timeout: 5 }).catch(() => undefined);
  }

  if (!url) verified = true;
}
