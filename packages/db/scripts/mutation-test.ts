/**
 * Mutation-tests the isolation suite.
 *
 * A test that passes whether or not the control exists is decorative. This
 * script breaks one control at a time, runs the suite, and records which tests
 * noticed. A mutation that kills nothing is a gap in the tests; a mutation that
 * kills everything usually means the mutation was too blunt to be informative.
 *
 * Each mutation starts from a freshly migrated schema, so mutations cannot
 * interact. Run it after changing any policy:
 *
 *   DATABASE_URL=... DATABASE_URL_OWNER=... tsx scripts/mutation-test.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

type Mutation = {
  name: string;
  /** What a developer might plausibly do by accident, or in a hurry. */
  description: string;
  sql?: string;
  /** A source edit, applied and reverted around the run. */
  edit?: { file: string; from: string; to: string };
};

const MUTATIONS: Mutation[] = [
  {
    name: 'drop-opportunities-policy',
    description: 'Drop the tenant_isolation policy on opportunities',
    sql: 'drop policy tenant_isolation on public.opportunities',
  },
  {
    // Calls hold a merchant's phone number and an agent's name, and arrive
    // partly from a webhook that takes its tenant from a URL.
    name: 'drop-calls-policy',
    description: 'Drop the tenant_isolation policy on calls',
    sql: 'drop policy tenant_isolation on public.calls',
  },
  {
    /*
     * The delivery record names a client's vendor traffic and, in `reasons`,
     * the values that vendor sends. A diagnostic table is still tenant data.
     */
    name: 'drop-webhook-deliveries-policy',
    description: 'Drop the tenant_isolation policy on webhook_deliveries',
    sql: 'drop policy tenant_isolation on public.webhook_deliveries',
  },
  {
    /*
     * The application reads deliveries and must not write them: a record of
     * what happened that a screen can edit is a way to make a silent endpoint
     * look busy. Row level security cannot restrict a column, so the grant is
     * the whole control — and a grant is exactly the kind of thing added in a
     * hurry because an insert was denied.
     */
    name: 'grant-app-write-on-webhook-deliveries',
    description: 'Give zeeraa_app INSERT and UPDATE on webhook_deliveries',
    sql: 'grant insert, update on public.webhook_deliveries to zeeraa_app',
  },
  {
    name: 'unforce-calls',
    description: 'Drop FORCE on calls, leaving the owner outside its policies',
    sql: 'alter table public.calls no force row level security',
  },
  {
    // A tenant-scoped table holding a third party's name. A submission says
    // which lender declined which merchant. A submission says which lender declined which merchant, so
    // a leak here is commercially sensitive in a way a click id is not.
    name: 'drop-submissions-policy',
    description: 'Drop the tenant_isolation policy on submissions',
    sql: 'drop policy tenant_isolation on public.submissions',
  },
  {
    name: 'unforce-submissions',
    description: 'Drop FORCE on submissions, leaving the owner outside its policies',
    sql: 'alter table public.submissions no force row level security',
  },
  {
    name: 'disable-rls-opportunities',
    description: 'Disable row level security on opportunities entirely',
    sql: 'alter table public.opportunities disable row level security',
  },
  {
    name: 'unforce-opportunities',
    description: 'Drop FORCE, leaving the owner outside the policies again',
    sql: 'alter table public.opportunities no force row level security',
  },
  {
    name: 'has-tenant-access-always-true',
    description: 'Make has_tenant_access() trust the requested tenant',
    sql: `create or replace function app.has_tenant_access() returns boolean
            language sql stable as $x$ select true $x$`,
  },
  {
    name: 'has-tenant-access-blanket-admin',
    description: 'Restore blanket cross-tenant access for any zeeraa_admin',
    sql: `create or replace function app.has_tenant_access() returns boolean
            language sql stable security definer
            set search_path = public, pg_temp
            set app.maintenance = 'on'
            as $x$
              select exists (
                select 1 from public.memberships m
                where m.user_id = app.current_user_id()
                  and (m.tenant_id = app.current_tenant_id() or m.role = 'zeeraa_admin')
              )
            $x$`,
  },
  {
    name: 'users-visible-to-all',
    description: 'Let the application read every user row',
    sql: `drop policy users_visible_within_tenant on public.users;
          create policy users_visible_within_tenant on public.users
            as permissive for select to zeeraa_app using (true)`,
  },
  {
    name: 'memberships-visible-to-all',
    description: 'Let the application read every membership row',
    sql: `drop policy memberships_self_or_current_tenant on public.memberships;
          create policy memberships_self_or_current_tenant on public.memberships
            as permissive for select to zeeraa_app using (true)`,
  },
  {
    name: 'maintenance-without-the-flag',
    description: 'Make the maintenance policy unconditional',
    sql: `drop policy maintenance_access on public.opportunities;
          create policy maintenance_access on public.opportunities
            as permissive for all to zeeraa_maintenance using (true) with check (true)`,
  },
  {
    name: 'cardinality-trigger-as-invoker',
    description: 'Revert the membership cardinality trigger to invoker rights',
    sql: `create or replace function app.enforce_membership_cardinality() returns trigger
            language plpgsql
            as $x$
            declare other_count integer;
            begin
              if new.role in ('client_admin','client_viewer') then
                select count(*) into other_count from public.memberships m
                  where m.user_id = new.user_id and m.tenant_id is distinct from new.tenant_id;
                if other_count > 0 then
                  raise exception 'User % holds a client role and may belong to exactly one tenant',
                    new.user_id using errcode = 'check_violation';
                end if;
              end if;
              return new;
            end; $x$`,
  },
  {
    name: 'definer-elevates-in-body',
    description: 'Elevate with set_config() in the body instead of a SET clause',
    sql: `create or replace function app.has_tenant_access() returns boolean
            language sql volatile security definer
            set search_path = public, pg_temp
            as $x$
              select set_config('app.maintenance', 'on', true) is not null
                 and exists (
                   select 1 from public.memberships m
                   where m.user_id = app.current_user_id()
                     and m.tenant_id = app.current_tenant_id()
                 )
            $x$`,
  },
  {
    name: 'membership-index-readable-by-app',
    description: 'Grant the application read access to the authorisation mirror',
    // The mirror answers every policy in the schema. A SELECT grant on it hands
    // `zeeraa_app` every tenant's membership list in one query, which is the
    // leak the absent grant exists to prevent.
    sql: 'grant select on app.membership_index to zeeraa_app',
  },
  {
    name: 'membership-index-drift',
    description: 'Let the mirror disagree with memberships',
    // Authorisation reads a denormalised copy, so a copy that drifts is a
    // wrong access decision. Dropping the sync trigger is how it would happen.
    sql: 'drop trigger memberships_index_sync on public.memberships',
  },
  {
    name: 'job-role-unscoped',
    description: 'Let the ingestion role reach every tenant instead of one',
    sql: `drop policy job_tenant_isolation on public.opportunities;
          create policy job_tenant_isolation on public.opportunities
            as permissive for all to zeeraa_jobs using (true) with check (true)`,
  },
  {
    name: 'job-role-gets-maintenance-door',
    // Role membership cannot be granted by the schema owner, which is itself a
    // useful boundary. The equivalent reachable mutation is to hand the jobs
    // role a maintenance-gated policy of its own.
    description: 'Give the ingestion role a maintenance door of its own',
    sql: `create policy job_maintenance ON public.opportunities
            AS PERMISSIVE FOR ALL TO zeeraa_jobs
            USING (app.is_maintenance()) WITH CHECK (app.is_maintenance())`,
  },
  {
    // A competitor's landing pages and the queries they rank for is a
    // commercial map of their acquisition.
    name: 'drop-ga4-policy',
    description: 'Drop the tenant_isolation policy on ga4_metrics',
    sql: 'drop policy tenant_isolation on public.ga4_metrics',
  },
  {
    name: 'unforce-ga4',
    description: 'Drop FORCE on ga4_metrics, leaving the owner outside its policies',
    sql: 'alter table public.ga4_metrics no force row level security',
  },
  {
    name: 'drop-search-console-policy',
    description: 'Drop the tenant_isolation policy on search_console_metrics',
    sql: 'drop policy tenant_isolation on public.search_console_metrics',
  },
  {
    name: 'search-console-job-role-unscoped',
    description: 'Let the ingestion role read every tenant’s Search Console rows',
    sql: `drop policy job_tenant_isolation on public.search_console_metrics;
          create policy job_tenant_isolation on public.search_console_metrics
            as permissive for all to zeeraa_jobs using (true) with check (true)`,
  },
  {
    // Both APIs restate for days. An append here would double every figure on
    // the organic pages on the second night.
    name: 'organic-metrics-appendable',
    description: 'Drop the upsert key on search_console_metrics',
    sql: 'drop index public.search_console_metrics_upsert_key',
  },
  {
    // 0027: account administration is a Zeeraa admin's alone. Each of these
    // restores 0017's client-admin clause to one account policy — exactly the
    // edit somebody makes to "let the client add their own new hire".
    name: 'client-admin-can-grant-access',
    description: 'Let a client admin grant membership again (the 0017 policy)',
    sql: `drop policy memberships_admin_write on public.memberships;
          create policy memberships_admin_write on public.memberships
            as permissive for insert to zeeraa_app
            with check (tenant_id = app.current_tenant_id()
                        and app.effective_role() in ('zeeraa_admin','client_admin'))`,
  },
  {
    name: 'client-admin-can-remove-access',
    description: 'Let a client admin remove anybody from their tenant, Zeeraa admins included',
    sql: `drop policy memberships_admin_remove on public.memberships;
          create policy memberships_admin_remove on public.memberships
            as permissive for delete to zeeraa_app
            using (tenant_id = app.current_tenant_id()
                   and app.effective_role() in ('zeeraa_admin','client_admin'))`,
  },
  {
    // The one that mattered most: a reset hands the new password back, and
    // the target can be a Zeeraa admin who reaches every client.
    name: 'client-admin-can-reset-passwords',
    description: "Let a client admin reset any password in their tenant, a Zeeraa admin's included",
    sql: `drop policy users_admin_manage on public.users;
          create policy users_admin_manage on public.users
            as permissive for update to zeeraa_app
            using (app.effective_role() in ('zeeraa_admin','client_admin')
                   and exists (select 1 from public.memberships m
                               where m.user_id = users.id and m.tenant_id = app.current_tenant_id()))
            with check (app.effective_role() in ('zeeraa_admin','client_admin')
                   and exists (select 1 from public.memberships m
                               where m.user_id = users.id and m.tenant_id = app.current_tenant_id()))`,
  },
  {
    name: 'client-admin-can-create-accounts',
    description: 'Let a client admin create accounts again',
    sql: `drop policy users_admin_create on public.users;
          create policy users_admin_create on public.users
            as permissive for insert to zeeraa_app
            with check (app.effective_role() in ('zeeraa_admin','client_admin'))`,
  },
  {
    name: 'last-zeeraa-admin-unprotected',
    description: 'Drop the trigger that keeps one Zeeraa admin on every tenant',
    sql: 'drop trigger memberships_protect_last_zeeraa_admin on public.memberships',
  },
  {
    // 0028: membership reads, it does not write. Restoring the FOR ALL policy
    // on one table is the edit that "fixes" a denied write in a hurry.
    name: 'tenant-config-writable-by-members',
    description: 'Make tenant_isolation on tenant_config FOR ALL again',
    sql: `drop policy tenant_isolation on public.tenant_config;
          create policy tenant_isolation on public.tenant_config
            as permissive for all to zeeraa_app
            using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
            with check (tenant_id = app.current_tenant_id() and app.has_tenant_access())`,
  },
  {
    name: 'opportunities-writable-by-members',
    description: 'Make tenant_isolation on opportunities FOR ALL again',
    sql: `drop policy tenant_isolation on public.opportunities;
          create policy tenant_isolation on public.opportunities
            as permissive for all to zeeraa_app
            using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
            with check (tenant_id = app.current_tenant_id() and app.has_tenant_access())`,
  },
  {
    name: 'tenant-admin-write-any-role',
    description: 'Drop the Zeeraa-admin test from tenant_admin_write on tenant_config',
    sql: `drop policy tenant_admin_write on public.tenant_config;
          create policy tenant_admin_write on public.tenant_config
            as permissive for all to zeeraa_app
            using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
            with check (tenant_id = app.current_tenant_id() and app.has_tenant_access())`,
  },
  {
    // The pre-0028 policy: any column of your own row, email included.
    name: 'self-update-policy-restored',
    description: 'Restore users_update_self, letting anyone edit their own row',
    sql: `create policy users_update_self on public.users
            as permissive for update to zeeraa_app
            using (id = app.current_user_id()) with check (id = app.current_user_id())`,
  },
  {
    name: 'own-row-guard-dropped',
    description: 'Drop the trigger that holds a self-update to a password change',
    sql: 'drop trigger users_guard_own_account_row on public.users',
  },
  {
    // A frozen baseline must not move for any role, including one that
    // bypasses row level security — which only the trigger can hold.
    name: 'baseline-append-only-dropped',
    description: 'Drop the trigger that keeps a frozen baseline from being edited',
    sql: 'drop trigger baseline_snapshots_append_only on public.baseline_snapshots',
  },
  {
    name: 'job-read-targets-unscoped',
    description: 'Let the ingestion role read every tenant’s engagement targets',
    sql: `drop policy job_read_targets on public.engagement_targets;
          create policy job_read_targets on public.engagement_targets
            as permissive for select to zeeraa_jobs using (true)`,
  },
  {
    name: 'drop-reconciliation-policy',
    description: 'Drop the tenant_isolation policy on reconciliation_checks',
    sql: 'drop policy tenant_isolation on public.reconciliation_checks',
  },
  {
    name: 'reconciliation-member-write',
    description: 'Let any member rewrite a reconciliation check, so drift can read as a match',
    sql: `grant update on public.reconciliation_checks to zeeraa_app;
          create policy member_write on public.reconciliation_checks
            as permissive for update to zeeraa_app
            using (tenant_id = app.current_tenant_id())
            with check (tenant_id = app.current_tenant_id())`,
  },
  {
    name: 'drop-sync-days-policy',
    description: 'Drop the tenant_isolation policy on sync_days',
    sql: 'drop policy tenant_isolation on public.sync_days',
  },
  {
    name: 'sync-days-member-write',
    description: 'Let any member write sync_days, so an unread day can be made to look read',
    sql: `drop policy tenant_admin_write on public.sync_days;
          grant insert on public.sync_days to zeeraa_app;
          create policy tenant_admin_write on public.sync_days
            as permissive for all to zeeraa_app
            using (tenant_id = app.current_tenant_id())
            with check (tenant_id = app.current_tenant_id())`,
  },
  {
    // 0028 shipped the guard as SECURITY INVOKER, and admin recovery through
    // `set-password.ts` failed on schema `app` until 0029. Reverting it is the
    // plausible accident: it looks like tightening.
    name: 'own-row-guard-invoker',
    description: 'Run the account-row guard as the invoker again, which locks maintenance out of users',
    sql: 'alter function app.guard_own_account_row() security invoker',
  },
  {
    name: 'membership-write-unscoped',
    description: 'Let an admin grant access to a tenant other than their own',
    sql: `drop policy memberships_admin_write on public.memberships;
          create policy memberships_admin_write on public.memberships
            as permissive for insert to zeeraa_app
            with check (app.effective_role() = 'zeeraa_admin')`,
  },
  {
    // Row level security cannot restrict columns, so the column grant is the
    // only thing standing between `memberships_update_own` and self-promotion.
    name: 'membership-role-self-updatable',
    description: 'Restore the table-wide UPDATE grant, making role self-writable',
    sql: 'grant update on public.memberships to zeeraa_app',
  },
  {
    name: 'user-create-open-to-anyone',
    description: 'Let any role in the tenant create an account, not only an admin',
    sql: `drop policy users_admin_create on public.users;
          create policy users_admin_create on public.users
            as permissive for insert to zeeraa_app with check (true)`,
  },
  {
    // Dropped entirely rather than widened. Widening it — removing only the
    // tenant clause — survives every test, and that is a fact about the schema
    // rather than a gap in the suite: `users_visible_within_tenant` already
    // refuses to surface a user from another tenant, so the row cannot be found
    // to update and the statement reports `UPDATE 0`. The tenant clause on
    // `users_admin_manage` is a second lock on a door the first one holds shut,
    // and no test can observe it alone. `users-visible-to-all` covers the lock
    // that is actually load-bearing.
    name: 'password-reset-policy-dropped',
    description: 'Remove the policy that lets an admin reset a password at all',
    sql: 'drop policy users_admin_manage on public.users',
  },
  {
    name: 'sessions-readable-by-app-role',
    description: 'Grant the application role the session table, and with it every live token',
    sql: `grant select on public.sessions to zeeraa_app;
          create policy sessions_app_read on public.sessions
            as permissive for select to zeeraa_app using (true)`,
  },
  {
    // The policy that lets a removed member be re-granted. Without the role
    // test it hands every signed-in user the set of unattached accounts.
    name: 'unattached-resolve-open-to-anyone',
    description: 'Let any role resolve an account that belongs to no tenant',
    sql: `drop policy users_admin_resolve_unattached on public.users;
          create policy users_admin_resolve_unattached on public.users
            as permissive for select to zeeraa_app
            using (not app.holds_any_membership(users.id))`,
  },
  {
    // The half that keeps it from becoming a directory of every client's
    // people. `holds_any_membership` reads `app.membership_index` as definer
    // for exactly this reason.
    name: 'unattached-resolve-sees-every-user',
    description: 'Drop the unattached test, surfacing other engagements’ rosters',
    sql: `drop policy users_admin_resolve_unattached on public.users;
          create policy users_admin_resolve_unattached on public.users
            as permissive for select to zeeraa_app
            using (app.effective_role() = 'zeeraa_admin')`,
  },
  {
    // As an invoker-rights function the helper reads `memberships` under the
    // caller's own policies, which show only their tenant — so a user attached
    // solely to another tenant would read as unattached and become visible.
    name: 'holds-any-membership-as-invoker',
    description: 'Make the unattached test read memberships as the caller',
    sql: `create or replace function app.holds_any_membership(target uuid) returns boolean
            language sql stable
            as $x$ select exists (select 1 from public.memberships m where m.user_id = target) $x$`,
  },
  {
    // A ramp states what one client pays and what was promised them. Another
    // engagement reading it learns the pricing.
    name: 'drop-engagement-targets-policy',
    description: 'Drop the tenant_isolation policy on engagement_targets',
    sql: 'drop policy tenant_isolation on public.engagement_targets',
  },
  {
    name: 'unforce-engagement-targets',
    description: 'Drop FORCE on engagement_targets, leaving the owner outside its policies',
    sql: 'alter table public.engagement_targets no force row level security',
  },
  {
    name: 'session-scoped-tenant-context',
    description: 'Set tenant context on the session instead of the transaction',
    edit: {
      file: 'src/tenant-context.ts',
      from: "set_config('app.current_tenant_id', ${ctx.tenantId}, true)",
      to: "set_config('app.current_tenant_id', ${ctx.tenantId}, false)",
    },
  },
];

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/zeeraa',
  DATABASE_URL_OWNER:
    process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa',
};

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { env, encoding: 'utf8', stdio: 'pipe' });
}

function rebuild() {
  run('npx', ['tsx', 'scripts/reset.ts']);
  run('npx', ['tsx', 'scripts/bootstrap-roles.ts']);
  run('npx', ['tsx', 'scripts/migrate.ts']);
}

const APPLY_SCRIPT = 'scripts/.mutation-apply.mts';

function applySql(statements: string) {
  // Written to a file rather than passed to `tsx --eval`, which compiles as CJS
  // and rejects top-level await.
  writeFileSync(
    APPLY_SCRIPT,
    `import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} });
await sql.unsafe(${JSON.stringify(statements)});
await sql.end();
`,
  );
  try {
    run('npx', ['tsx', APPLY_SCRIPT]);
  } finally {
    rmSync(APPLY_SCRIPT, { force: true });
  }
}

/** Runs the suite and returns the names of the tests that failed. */
function failingTests(): string[] {
  try {
    run('npx', ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/mutation-result.json']);
  } catch {
    // Non-zero exit is the expected outcome; the report is what matters.
  }
  try {
    const report = JSON.parse(readFileSync('/tmp/mutation-result.json', 'utf8'));
    return (report.testResults ?? [])
      .flatMap((f: { assertionResults?: { status: string; fullName: string }[] }) =>
        (f.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => a.fullName),
      );
  } catch {
    return ['<suite failed to run>'];
  }
}

const results: { mutation: Mutation; killedBy: string[]; applied: boolean }[] = [];

for (const mutation of MUTATIONS) {
  process.stderr.write(`\n▸ ${mutation.name}\n`);
  rebuild();

  let original: string | undefined;
  if (mutation.edit) {
    original = readFileSync(mutation.edit.file, 'utf8');
    if (!original.includes(mutation.edit.from)) {
      throw new Error(`Mutation ${mutation.name}: anchor not found in ${mutation.edit.file}`);
    }
    writeFileSync(mutation.edit.file, original.replace(mutation.edit.from, mutation.edit.to));
  }
  let applied = true;
  if (mutation.sql) {
    try {
      applySql(mutation.sql);
    } catch (error) {
      // A mutation that cannot be applied proves nothing either way, and it
      // must not take the rest of the run down with it.
      applied = false;
      process.stderr.write(`  could not apply: ${String(error).slice(0, 200)}\n`);
    }
  }

  const killedBy = applied ? failingTests() : ['<mutation could not be applied>'];
  if (mutation.edit && original) writeFileSync(mutation.edit.file, original);

  results.push({ mutation, killedBy, applied });
  process.stderr.write(`  ${killedBy.length} test(s) failed\n`);
}

rebuild();

console.log('\n\n=== Mutation results ===\n');
let survivors = 0;
let inapplicable = 0;
for (const { mutation, killedBy, applied } of results) {
  if (!applied) inapplicable += 1;
  else if (killedBy.length === 0) survivors += 1;
  const label = !applied ? 'SKIPPED ' : killedBy.length === 0 ? 'SURVIVED' : 'killed  ';
  console.log(`${label}  ${mutation.name}`);
  console.log(`          ${mutation.description}`);
  for (const name of killedBy.slice(0, 6)) console.log(`          ✗ ${name}`);
  if (killedBy.length > 6) console.log(`          … and ${killedBy.length - 6} more`);
  console.log();
}
console.log(
  `${results.length - survivors - inapplicable}/${results.length - inapplicable} mutations killed` +
    (inapplicable > 0 ? `, ${inapplicable} could not be applied.` : '.'),
);
if (survivors > 0) {
  console.log(`${survivors} survived — those controls are not covered by a test.`);
  process.exitCode = 1;
}
