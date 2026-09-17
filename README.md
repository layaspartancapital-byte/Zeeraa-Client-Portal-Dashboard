# Zeeraa client performance platform

A multi-tenant marketing performance and delivery platform. Spartan Capital
Group is tenant #1, not the only tenant: nothing client-specific lives in code,
only in configuration rows.

The platform does three jobs.

1. **Prove the economics.** Join ad spend to funded deals and report cost per
   funded deal.
2. **Report the work.** Live, monthly, platform-by-platform performance.
3. **Deliver the work.** Zeeraa uploads articles, placements, creatives and
   reports, mentions the responsible person at the client, and that person
   reviews and approves in place.

The product is the join between two worlds that otherwise cannot see each other:

```
click ID → campaign    → spend                                (ad platform APIs)
click ID → opportunity → stage timestamps → funded amount     (Salesforce)
```

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Foundation — schema, migrations, RLS, leak test, auth, roles, tenant switcher, app shell | **Done** |
| 2 | Salesforce — JWT connection, incremental sync, both attribution models | Not started |
| 3 | The join and the executive view — Google Ads, metric definitions, provenance | Not started |
| 4 | Monthly performance and funnel | Not started |
| 5 | Content and approval workspace | Not started |
| 6 | Notifications | Not started |
| 7 | Remaining connectors | Not started |
| 8 | Hardening, print, CSV, second tenant | Not started |

What phase 1 deliberately does **not** include: any ingested data. Every screen
that would show a figure renders an explicit empty state naming what is missing,
because a zero would read as a measurement.

## Repository

```
apps/web            Next.js app (UI + API routes)
packages/db         Drizzle schema, migrations, RLS policies, seeds
packages/core       Metric definitions, formatting, roles, shared types
packages/connectors One module per platform, behind a shared interface
packages/jobs       Inngest functions (ingestion, notifications, digests)
```

## Getting started

```bash
pnpm install
pnpm db:up                                   # local Postgres on 5433
cp .env.example apps/web/.env.local          # then fill in the blanks

export DATABASE_URL=postgres://postgres:postgres@localhost:5433/zeeraa
export DATABASE_URL_OWNER=postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa

pnpm --filter @zeeraa/db bootstrap           # creates the roles. Run first.
pnpm db:migrate                              # runs as zeeraa_owner
SEED_USERS=yes pnpm db:seed                  # Spartan config + two dev users

pnpm dev
```

Order matters: `bootstrap` creates the roles the migrations grant to, and makes
`zeeraa_owner` own the schema.

Sign-in needs a Resend key or Google credentials. To work without either:

```bash
cd packages/db
npx tsx scripts/dev-session.ts admin@zeeraa.com
# paste the value as the `authjs.session-token` cookie on localhost:3000
```

## Tenant isolation

Every tenant-scoped table carries `ENABLE` **and** `FORCE ROW LEVEL SECURITY`,
so the policies bind the role that owns the tables as well as the one the
application uses. Five roles, each with the least it needs:

- **administrative** (`postgres`, or your provider's superuser) — creates roles.
  Used by `bootstrap` and `reset`, nothing else.
- **`zeeraa_owner`** — owns the schema. Migrations and seeds. `NOSUPERUSER` and
  `NOBYPASSRLS`, so FORCE genuinely binds it. This is why migrations do not run
  as `postgres`: a superuser bypasses row level security whatever is set, and
  local development would then be exercising a weaker rule than production.
- **`zeeraa_app`** — the runtime role. Owns nothing, and every statement it
  issues is filtered by a policy.
- **`zeeraa_auth`** — the Auth.js adapter. Identity tables only.
- **`zeeraa_maint`** — backfill scripts and psql sessions. Member of
  `zeeraa_maintenance`.

Tenant context arrives as transaction-local settings set by `withTenant()`.
Outside that wrapper there is no context, every policy evaluates to false, and
every tenant-scoped query returns zero rows — so the cost of forgetting the
wrapper is an empty screen, never another client's data.

A Zeeraa admin can work in any tenant they hold a **membership row** for, and no
others. There is no blanket cross-tenant grant by role: "who can read this
client?" is always answerable by querying `memberships`.

### The maintenance gate

Because FORCE binds the owner too, work that genuinely crosses tenants — seeding
a client, repairing a bad import — goes through `withMaintenance()`, which sets
`app.maintenance` for one transaction. Membership of `zeeraa_maintenance` is
necessary but not sufficient, so an idle psql session as the owner still reads
nothing. `zeeraa_app` is not a member, so setting the flag from a web request
buys nothing at all.

### Pooling, and the preflight check

Tenant context is carried by `set_config(..., true)`, which is transaction
-scoped. That is safe on a direct connection and behind a pooler in
**transaction** mode — Neon's pooled endpoint, PgBouncer
`pool_mode = transaction`. It is not safe in `statement` mode, where one
transaction's statements can be spread across backends.

This is not left to documentation. `assertTransactionLocalContext()` probes the
configured connection before anything is served: it sets a value in a
transaction, reads it back in a second statement, and checks it is gone after
the commit. If either direction is wrong it refuses to serve, because the
failure it catches is invisible — a statement-mode pooler does not corrupt data,
it quietly makes every policy evaluate against a null tenant, which looks like a
broken product and invites someone to "fix" it by loosening a policy.

Run the same checks in the deploy pipeline so a misconfigured `DATABASE_URL_APP`
breaks the deploy rather than reaching production:

```bash
pnpm --filter @zeeraa/db preflight
```

Both directions are verified against a real PgBouncer in CI — statement mode
must be refused, transaction mode must be accepted and must pass the full
isolation suite.

### Tests

`packages/db/test/` runs against a real Postgres and deliberately writes the
queries a developer writes on a bad day — no tenant filter, the wrong tenant id
supplied on purpose, a role claim escalated in the session — and asserts the
database returns nothing.

```bash
pnpm db:up
DATABASE_URL_OWNER=postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa pnpm test
```

Those tests are themselves verified by mutation testing. `mutation-test.ts`
breaks one control at a time — drops a policy, reverts the cardinality trigger
to invoker rights, makes tenant context session-scoped — and reports which tests
noticed. A mutation that survives is a control with no test behind it.

```bash
pnpm --filter @zeeraa/db mutation-test
```

This runs on every pull request. The isolation suite decayed into a partly
-decorative state once already — several tests exercised the database as a
superuser, where row level security does not apply, and so proved nothing about
the path the application takes. The mutation job is what stops that recurring
between audits.

## Adding a table

No default privileges are granted to the runtime roles. A new tenant-scoped
table must, in its own migration, grant to `zeeraa_app`, enable row level
security, and create its policy. A table that skips this is unreachable from the
application and fails `assertRlsEnforced()` at startup — which is the intended
failure mode, rather than a quietly unprotected table.

## Adding a tenant

A tenant is a seed file implementing `TenantSeed` plus one call to
`applyTenantSeed`. Funnel stages, metrics, targets, commitments, SLAs, asset
types and conflicting figures are all rows. The funnel engine reads
`funnel_stages`, so a tenant running Lead → Demo → Trial → Subscription renders
on the same screens with no code change.

## Unreconciled figures

Several numbers in Spartan's paperwork are stated two ways — CPA as both
$2,000→$1,000 and $108.59, the owned database as both 1M and 100,000 records.
These are recorded in `reconciliation_items` and surfaced on the admin screen.
They are never rendered as committed progress, and no metric target flagged
`needs_reconciliation` is drawn as a target line.
