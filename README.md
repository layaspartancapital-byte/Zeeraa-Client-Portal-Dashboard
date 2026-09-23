# Zeeraa client performance platform

A multi-tenant marketing performance and attribution platform. Spartan Capital
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
| 2 | Salesforce — JWT connection, incremental sync, both attribution models | **Partial** — attribution blocked |
| — | Ingestion: Inngest jobs, Postgres writer, click-ID backfill | Done |
| 3 | The join and the executive view — Google Ads, metric definitions, provenance | Not started |
| 4 | Monthly performance and funnel | Not started |
| 5 | Content and approval workspace | **Removed** — see below |
| 6 | Notifications | Not started |
| 7 | Remaining connectors | Not started |
| 8 | Hardening, print, CSV, second tenant | Not started |

**Phase 5 was built and then removed**, on 21 September 2026. Zeeraa's delivery
flow happens in Slack and Drive, and an empty workspace reads as a client being
failed rather than as a feature going unused. The reasoning, and everything the
removal took with it, is in `docs/brief-amendments.md`, "§9, §10 and §14 — the
workspace and the delivery view are removed".

What phase 1 deliberately does **not** include: any ingested data. Every screen
that would show a figure renders an explicit empty state naming what is missing,
because a zero would read as a measurement.

### Phase 2: what the org probe found

`packages/connectors/scripts/probe-salesforce.ts` answers four questions about
a client's org, read-only, and exits non-zero if any comes back blocked:

```bash
SF_CLIENT_ID=… SF_USERNAME=… SF_PRIVATE_KEY_BASE64=… \
  SF_LOGIN_URL=https://login.salesforce.com \
  pnpm --filter @zeeraa/connectors probe
```

Against Spartan's org:

| Question | Result |
| --- | --- |
| Click ID survives Lead → Opportunity conversion | **blocked** — Opportunity fields and lead mappings being created |
| Per-stage timestamps | explicit `csbs__` datetime fields, not field history |
| Decline reason populated | 16.4% of closed-lost |
| Deletions and merges visible | yes — both handled |

**Attribution is not built**, and will not be until the click-ID mapping is
confirmed with `validateMapping`. Everything else is: leads, opportunities,
stage events, the derived MQL stage, decline reasons, delete/merge
reconciliation, and the converted-Lead backfill.

### Ingestion

Runs on **Vercel Cron**, the only scheduler (`apps/web/vercel.json`): the
hourly incremental sync (`/api/cron/sync`), the nightly 90-day re-pull
(`/api/cron/nightly`) and the daily reconciliation and baseline freeze
(`/api/cron/reconcile`). Inngest was removed on 18 September 2026; see
`docs/state.md` for what had to be disconnected on its side.

Ingestion connects as **`zeeraa_jobs_runner`**, a fifth role. A sync writes on
nobody's behalf, so it cannot use the user-scoped policies — but giving it the
maintenance connection would let one connector bug reach every tenant at once.
Instead its policies scope it to a tenant without a user, and grant it only the
tables ingestion writes: no notifications, no memberships, no identity tables,
and no maintenance door.

The converted-Lead backfill is a first-class, re-runnable sync step rather than
a script. It recovers click IDs for opportunities that converted before the
field mapping existed, writing with `source = 'lead_conversion'` — a different
key from the mapped field's `opportunity_field`, so the two routes can never
overwrite each other and a disagreement between them exposes a gap in the
mapping.

`docs/salesforce-fields.md` is the specification for what the admin needs to
create, including the three ways that work can silently fail.

## Repository

```
apps/web            Next.js app (UI + API routes)
packages/db         Drizzle schema, migrations, RLS policies, seeds
packages/core       Metric definitions, formatting, roles, shared types
packages/connectors One module per platform, behind a shared interface
packages/jobs       Ingestion, the nightly re-pull, reconciliation and the baseline freeze
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

`SEED_USERS=yes` creates `admin@zeeraa.com` (Zeeraa admin) and
`ceo@spartancapitalgroup.com` (client admin), both with the password
`zeeraa-development-password` and both required to change it on first sign-in.
It refuses to run against anything but a local database.

## Sign-in

An email address and a password. **No email is sent by this product and nobody
registers themselves**: an admin creates the account on the People screen, the
app generates the initial password and shows it once, the admin passes it on out
of band, and the person is required to replace it before they can reach anything.

- Passwords are argon2id (19 MiB, two passes), in PHC format, so the cost can be
  raised later without invalidating a stored hash.
- A session is a row in `sessions` named by a 256-bit opaque cookie — not a JWT,
  because an admin resetting a password has to end the sessions that password
  obtained, on the next request rather than whenever a token expires.
- Creating an account and granting it access stay two acts. A user row with no
  membership can sign in and reaches `/no-access`, nothing else.
- A Zeeraa admin may add anybody to the tenant they are working in; a client
  admin may add people to their own engagement, and may not grant a Zeeraa role.
  The role picker reflects that and `memberships_admin_write` enforces it.
- There is no password recovery, because there is no mailbox to recover through.
  The replacement is an admin reset, which issues a new password and closes
  every session the account holds.

An account that belongs to **no** engagement — because its access was removed —
can be added back on the People screen. One that belongs to a **different**
engagement cannot be seen from there by anybody, because it is another client's
roster.

Two operations therefore sit outside the application, gated on holding the
maintenance connection string rather than on being signed in:

```bash
# The first account on a new deployment, which has nobody to create it.
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db set-password someone@example.com

# Moving an account between engagements.
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db grant-membership someone@example.com acme client_admin

# Deleting an account outright — a mistyped address, say. Refuses while the
# account still has access to anything.
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db delete-account someone@example.com
```

Removing access and deleting an account are different acts and stay different.
The People screen removes a membership and leaves the account, because it may
hold other engagements. Only the last command above removes the account itself,
and it refuses while any membership exists — a cascade through `memberships`
would be a revocation with nothing saying it happened.

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
- **`zeeraa_auth`** — sign-in and sessions. Identity tables only: a sign-in
  happens before any tenant exists in the request, so it cannot satisfy the
  tenant policies.
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
`applyTenantSeed`. Funnel stages, metrics, targets and conflicting figures are
all rows. The funnel engine reads
`funnel_stages`, so a tenant running Lead → Demo → Trial → Subscription renders
on the same screens with no code change.

## Unreconciled figures

Several numbers in Spartan's paperwork are stated two ways — CPA as both
$2,000→$1,000 and $108.59, the owned database as both 1M and 100,000 records.
These are recorded in `reconciliation_items` and surfaced on the admin screen.
They are never rendered as committed progress, and no metric target flagged
`needs_reconciliation` is drawn as a target line.
