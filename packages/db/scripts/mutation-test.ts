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

const results: { mutation: Mutation; killedBy: string[] }[] = [];

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
  if (mutation.sql) applySql(mutation.sql);

  const killedBy = failingTests();
  if (mutation.edit && original) writeFileSync(mutation.edit.file, original);

  results.push({ mutation, killedBy });
  process.stderr.write(`  ${killedBy.length} test(s) failed\n`);
}

rebuild();

console.log('\n\n=== Mutation results ===\n');
let survivors = 0;
for (const { mutation, killedBy } of results) {
  if (killedBy.length === 0) survivors += 1;
  console.log(`${killedBy.length === 0 ? 'SURVIVED' : 'killed  '}  ${mutation.name}`);
  console.log(`          ${mutation.description}`);
  for (const name of killedBy.slice(0, 6)) console.log(`          ✗ ${name}`);
  if (killedBy.length > 6) console.log(`          … and ${killedBy.length - 6} more`);
  console.log();
}
console.log(`${results.length - survivors}/${results.length} mutations killed.`);
if (survivors > 0) {
  console.log(`${survivors} survived — those controls are not covered by a test.`);
  process.exitCode = 1;
}
