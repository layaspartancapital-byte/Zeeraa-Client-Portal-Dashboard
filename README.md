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
pnpm --filter @zeeraa/db bootstrap           # creates the two runtime roles
pnpm db:migrate
SEED_USERS=yes pnpm db:seed                  # Spartan config + two dev users

pnpm dev
```

Sign-in needs a Resend key or Google credentials. To work without either:

```bash
cd packages/db
npx tsx scripts/dev-session.ts admin@zeeraa.com
# paste the value as the `authjs.session-token` cookie on localhost:3000
```

## Tenant isolation

Three roles connect to the database and none of them is the one the application
uses for tenant data by accident:

- **owner** — migrations and seeds only. Never used by the application.
- **`zeeraa_app`** — the runtime role. `NOBYPASSRLS`, owns nothing, and every
  statement it issues is filtered by a row level security policy.
- **`zeeraa_auth`** — the Auth.js adapter. Reaches `users`, `accounts`,
  `sessions` and `verification_tokens`, and no tenant-scoped table at all.

Tenant context arrives as transaction-local settings set by `withTenant()`.
Outside that wrapper there is no context, every policy evaluates to false, and
every tenant-scoped query returns zero rows — so the cost of forgetting the
wrapper is an empty screen, never another client's data.

`assertRlsEnforced()` runs on the first database-backed request and refuses to
serve if the runtime role could bypass RLS.

`packages/db/test/tenant-isolation.test.ts` runs against a real Postgres and
deliberately writes the queries a developer writes on a bad day — no tenant
filter, the wrong tenant id supplied on purpose, a role claim escalated in the
session — and asserts the database returns nothing.

```bash
pnpm db:up
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zeeraa pnpm test
```

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
