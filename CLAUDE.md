# Working in this repository

## Guardrails (from the build brief, §16)

- **No client-specific logic in code.** If it is Spartan-specific, it is a
  config row. There is no `offer_rate` column; "offer rate" is one instance of
  `stage_conversion_rate(n, n+1)` over `funnel_stages`.
- **Never append to `daily_metrics`.** Always upsert. Platforms restate
  conversions for 30+ days; the nightly job re-pulls a trailing 90-day window,
  and an append would double-count every restatement.
- **Never render a number without a resolvable source.** Render an explicit
  empty state instead. `Sourced<T>` in `packages/core` makes this a type error
  rather than a code review note.
- **Never rely on application-level tenant filtering alone.** Every tenant
  query goes through `withTenant()`, which must stay transaction-scoped —
  `set_config(..., true)`. A session-level SET would leak across pooled
  requests.
- **Crossing tenants is explicit.** `withMaintenance()` is the only way, it
  needs a role the application does not have, and it greps.
- **Ingestion uses `withJobTenant()`**, never `withMaintenance()`. A sync writes
  on nobody's behalf, so it is scoped to a tenant without a user — and a
  connector bug must not be able to reach a second client.
- **A computed stage is not an observed one.** MQL has no timestamp in
  Salesforce and is derived from the qualification bar; it carries
  `origin = 'computed'` and must render as such.
- **Tests must not assume they own the database.** Packages test concurrently
  against one Postgres, and a maintenance read crosses tenants by design —
  scope assertions to the fixture's own tenants.
- **A Zeeraa admin needs a membership row per tenant.** No blanket grant by
  role: access has to be answerable from `memberships`, and revocable there.
- **Never expose a blob URL that is not signed and authorization-checked.**
  Blob keys are prefixed `tenant/{tenant_id}/`. No public objects.
- **The mention picker may never surface a user outside the current tenant.**
  Enforced by the `users` and `memberships` policies, not by a query filter.
- **A missing data dependency is an explicit blocked state in the UI**, not a
  silent gap. A visible dependency is a conversation; a gap looks like failure.

Where the implementation departs from the brief, the departure is recorded in
`docs/brief-amendments.md` with its reason. Add to it rather than letting the
code and the specification drift apart silently.

## State

`docs/state.md` is the running state of the build — current phase, what is done,
what is blocked, what is next. Read it first; update it at the end of every
session. It exists so a fresh session does not reconstruct the position from
commit history and get it wrong.

## Conventions

- Metrics are named, unit-tested functions in `packages/core`. Never recompute a
  metric inline in a component — the same word must mean the same thing on every
  screen.
- **A channel's metric takes both halves from that channel.** Cost per deal is
  that channel's spend over the deals attributed to that channel; a channel's
  conversion rate is its own numerator over its own denominator. Deals no
  channel can claim are their own count and never enter anybody's denominator —
  a metric that improves when a *different* channel has a good month is not
  measuring the channel it is named after. Use `channelCostPerDeal` and
  `channelReach`; both exist so the scoping cannot be forgotten at a call site.
  Blended-across-channels is a separate metric with a different denominator, and
  it does not mean anything until every channel is ingested.
- Dates are normalised into the tenant timezone **at ingest**, never at query
  time.
- Money is `numeric` in the database and never a float.
- Workspace packages ship TypeScript source. Relative imports are extensionless
  (Turbopack does not map `.js` specifiers onto `.ts` sources).
- Migrations are checked in. RLS policies are hand-written so the exact
  `USING`/`WITH CHECK` clauses are reviewable in the diff.
- A new tenant-scoped table must, in its own migration, grant to `zeeraa_app`,
  `enable` and `force` row level security, and create both its
  `tenant_isolation` and `maintenance_access` policies.
- Functions that read `memberships` from inside a policy must be SECURITY
  DEFINER with `SET app.maintenance = 'on'`. As invoker-rights functions they
  are subject to the very policies they are evaluating, and read nothing.
- After changing any policy, run `scripts/mutation-test.ts`. If a mutation
  survives, add the test before shipping.

## Design

Read §12 of the build brief before touching the UI. The short version:

- A light, ledger-like workspace. Gold is a signal (targets, north star, active
  tenant), never a surface.
- Panels are a hairline rule and whitespace. Not a grid of rounded cards with
  soft grey shadows. The only elevated surface is a modal.
- One radius (4px), on interactive elements only.
- `font-variant-numeric: tabular-nums` on every numeric cell, no exceptions.
- Positive and negative are never carried by colour alone — always a sign,
  arrow or label. Direction comes from each metric's `improvement_direction`;
  "up is green" is wrong here, because a falling cost per funded deal is good.
- Every figure carries a referent: value, comparison, and an explicit sign.
- Sentence case. No tracked-out all-caps eyebrows. No emoji, no per-metric icon.
- No celebration states anywhere. The delivery view is a compliance record.

## Commands

```bash
pnpm db:up                                      # local Postgres
pnpm --filter @zeeraa/db bootstrap              # create runtime roles (once)
pnpm db:migrate && SEED_USERS=yes pnpm db:seed
pnpm dev
pnpm -r typecheck
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zeeraa pnpm test
```

The isolation suite needs a real Postgres. It is testing properties of the
database; a mock would prove nothing.
