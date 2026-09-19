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
    // A client's unreleased creatives, and the approval record behind every
    // delivered figure.
    name: 'drop-assets-policy',
    description: 'Drop the tenant_isolation policy on assets',
    sql: 'drop policy tenant_isolation on public.assets',
  },
  {
    name: 'unforce-assets',
    description: 'Drop FORCE on assets, leaving the owner outside its policies',
    sql: 'alter table public.assets no force row level security',
  },
  {
    // The delivery view is a compliance record, which it only is while the
    // figure is one Zeeraa cannot raise on its own behalf.
    name: 'asset-review-trigger-dropped',
    description: 'Drop the trigger that decides who may approve an asset',
    sql: 'drop trigger assets_review_authority on public.assets',
  },
  {
    name: 'asset-approval-open-to-any-role',
    description: 'Let any role in the tenant approve work, not only the client admin',
    sql: `create or replace function app.enforce_asset_review_authority() returns trigger
            language plpgsql security definer
            set search_path = public, pg_temp
            as $fn$ begin return new; end; $fn$`,
  },
  {
    name: 'asset-version-chain-forkable',
    description: 'Drop the constraint that keeps a version chain a chain',
    sql: 'drop index public.assets_supersedes_unique',
  },
  {
    // Platforms restate; so do people. An append here would let one
    // commitment accumulate a row per approval and a figure that climbed with
    // the number of clicks.
    name: 'delivery-records-appendable',
    description: 'Drop the upsert key on deliverable_records',
    sql: 'drop index public.deliverable_records_upsert_key',
  },
  {
    name: 'activity-log-rewritable',
    description: 'Drop the append-only restriction on the audit trail',
    sql: `drop policy activity_log_append_only on public.activity_log;
          drop policy activity_log_no_delete on public.activity_log`,
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
