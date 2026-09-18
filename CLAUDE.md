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
- Functions that answer authorisation from inside a policy must be SECURITY
  DEFINER with a pinned `search_path`, and must read `app.membership_index`
  rather than `public.memberships`. As invoker-rights functions they would be
  subject to the very policies they are evaluating and read nothing; reading
  `memberships` as the definer would need elevation, and **the only elevation
  this database can express is a session-level flag, which a policy helper must
  never set** — the side effect would outlive the policy evaluation.
  `app.membership_index` is a synchronously-maintained mirror of
  (tenant, user, role) in the `app` schema with no grant to any application
  role, so it needs no elevation at all. Do not put a `SET app.maintenance`
  clause on a function: only a true superuser can grant SET on a custom
  parameter and a managed Postgres has none, so it does not deploy. See
  `docs/brief-amendments.md`, "§5 and §12 — the policy helpers no longer
  elevate".
- After changing any policy, run `scripts/mutation-test.ts` — against a
  throwaway database, because it drops the schema it points at. If a mutation
  survives, add the test before shipping; if you add a control, add the
  mutation that breaks it.
- A migration edit is inert on any database that has already run it: drizzle's
  ledger records the journal timestamp, not a hash of the file. A change that
  existing environments need has to be a new migration as well.

## Design

**§12 of the build brief is superseded. Design spec v2 governs the UI** — see
`docs/brief-amendments.md`, "§12 — replaced in full by design spec v2", for the
replacement and for every place the implementation states an exception to it.

The short version:

- A modern SaaS analytics dashboard. Fixed left sidebar, elevated white cards on
  a soft grey-blue canvas, one confident blue, Inter throughout.
- Every card has surface, radius (12px) and the two-layer shadow. A
  hairline-only panel is not a card in this system. No gold, no serif, no black
  band.
- `font-variant-numeric: tabular-nums` on every numeric value, via the
  `.numeric` / `.tabular` utilities.
- **No explanatory paragraph on a dashboard screen.** Every methodology note,
  caveat, definition and "why this is not measured" goes in an ⓘ (two sentences
  at most), in the "How this is measured" drawer, or as a one-line row in the
  data-quality card. An empty state is one line plus at most one action.
- Green and red mean improvement and regression as each metric's
  `improvement_direction` defines them, and nothing else. A delta always carries
  an arrow and a signed value as well as its colour. A metric with no configured
  direction renders its delta in `--text-2`.
- Every KPI card carries a mini chart. Where there is not enough history, draw
  the buckets that exist and leave the rest blank — never fake it, and never
  plot zero for a bucket nobody ingested.
- A blocked or unmeasured figure is an amber `Not measured` badge with the reason
  in its tooltip. Never a zero.
- No horizontal page scroll at any width down to 375px. Anything wide scrolls
  inside its own card, and the scroll container needs `min-w-0` or it widens the
  page instead.
- No celebration states anywhere. The delivery view is a compliance record.

**Attribution on screen.** The separation rule is not only arithmetic; it
governs layout, because a table puts two numbers on one line and the reader
assumes they are comparable.

- **Channel-attributed and unattributed figures never share a row.** The monthly
  table carries an explicit unattributed row group below a heavier rule, badged
  `Not a channel`: it has deals but no spend and no cost per deal, and those
  cells render as an em dash with the reason in an ⓘ, never as zero.
- **No total mixes them.** A totals row sums what is summable — spend across
  channels, deals across every source — and renders nothing where the sum would
  be a category error. Blended cost per deal is one of those until every channel
  is ingested.
- **A cost-per-deal figure carries its coverage and its range as part of the
  metric** — one small line under the number, with the full explanation in the
  ⓘ beside it. A bare cost-per-deal number never renders; `CostPerDealFigure`
  takes a `ChannelCostPerDeal` and there is no prop that accepts a plain number.

### Charts

Recharts, through the wrappers in `components/charts`. Two traps that cost real
time:

- **An axis must be a direct child of the chart.** Grouping `<XAxis>` and
  `<YAxis>` in a fragment hides them from the library's child scan, and you get
  gridlines with no tick labels and, in a horizontal layout, no bars at all.
- **A chart is a client component, so it cannot take a formatter function.**
  Pass a `FormatSpec` and a labels map; `format-spec.ts` resolves them, and the
  rules still come from `@zeeraa/core` so a value formats identically on an
  axis, in a table cell, in the CSV and on paper.

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
