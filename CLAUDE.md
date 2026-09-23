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
- **A migration that writes rows to a tenant-scoped table is default-denied.**
  The owner role migrations run as holds no policy on a table with FORCE, so a
  bare `UPDATE` or `DELETE` matches nothing, reports success and changes
  nothing. Bracket it with `NO FORCE` / `FORCE ROW LEVEL SECURITY` in the same
  migration and say why — `0016` is the worked example. Verify the row count.
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
- **Only a Zeeraa admin administers accounts.** Creating an account,
  granting or removing access, resetting a password and finding an unattached
  account all require `zeeraa_admin` in the current tenant — in
  `canManageUsers`, in every People server action, and in the account policies
  of migration 0027, which are what hold without the application. A client
  admin could once reset the password of a Zeeraa admin who shared their
  tenant, and be handed it; `apps/web/test/people-guard.test.ts` and
  `packages/db/test/account-admin.test.ts` keep that shut.
- **Nobody edits their own account row directly.** `users_change_own_password`
  admits a self-update only inside the change-password flow
  (`app.password_change`, transaction-local, set by `changeOwnPassword` after it
  verifies the current password), and `users_guard_own_account_row` holds it to
  a new hash with the forced-change flag cleared. An email, a name, or clearing
  a forced change without a new password are refused — including for a Zeeraa
  admin through the admin policy.
- **A tenant always keeps one Zeeraa admin.** `memberships_protect_last_zeeraa_admin`
  refuses removing the last one — by membership, by account deletion, or in a
  single statement removing several — for every role, maintenance included.
  Deleting the tenant itself is allowed; `app.tenant_index` is how the trigger
  tells the two apart.
- **`memberships` is not updatable from the application except for the two
  notification columns.** Row level security cannot restrict columns, so the
  column grant does it: `memberships_update_own` would otherwise let anybody
  set their own `role`, and `app.membership_index` is maintained from that
  table, so the promotion would take effect at once.
- **A password is argon2id, and a session is a row.** Never a JWT: an admin
  reset has to end the sessions it invalidates, on the next request. Password
  handling lives in `apps/web/src/lib/password.ts` and `session.ts`; the policy
  (length, no composition rules) is `packages/core/src/password.ts` so the
  sign-in screen, the forced-change screen and the admin form cannot disagree.
- **An account with no membership must stay reachable by an admin.** Removing
  access previously stranded it: the address is taken on a global unique index,
  so it cannot be created again, and `users_visible_within_tenant` cannot see a
  row that shares no tenant. `users_admin_resolve_unattached` covers exactly
  that case, and its unattached test must stay SECURITY DEFINER over
  `app.membership_index` — read as the invoker it would see only the caller's
  own memberships, and a user attached to another engagement would read as
  unattached.
- **Sign-in must not say whether an account exists.** One message for a wrong
  password and for an unknown address, and `verifyPassword` hashes against a
  decoy when there is no row, so the timing does not say what the message
  declines to. There is no self-registration and no email, so the list of
  addresses holding an account is worth protecting.
- **This product stores no client files.** The workspace, the S3 bucket and the
  signed-URL path were removed on 21 September 2026. If file storage ever
  returns, the rule it returns under is in `docs/brief-amendments.md`, "§9, §10
  and §14 — the workspace and the delivery view are removed": keys prefixed
  `tenant/{tenant_id}/`, no public objects, every URL signed and
  authorization-checked.
- **No screen may surface a user outside the current tenant.** Enforced by the
  `users` and `memberships` policies, not by a query filter.
- **A missing data dependency is an explicit blocked state in the UI**, not a
  silent gap. A visible dependency is a conversation; a gap looks like failure.
- **Coverage is by day, from `sync_days`.** Every pull records the days it
  covered and whether each had settled; a source resumes from its oldest day
  not read final. A range with an unread day is partial and names the days; a
  range with every day unread is Not measured; a chart leaves an unread day
  blank and draws a read empty day as 0. Never decide coverage from the last
  sync alone — that is how two unread days of Meta read as quiet ones.
- **A frozen baseline month is never edited.** `baseline_snapshots` is
  append-only for every role, including one that bypasses row level security
  (the trigger holds it). A correction is the next `version` with a `reason`.
  Its figures come from `channelMonthActuals` in core, which the live ramp also
  uses — never compute a ramp month anywhere else.
- **The daily reconciliation is the check that our figures are the source's.**
  A change that makes a figure differ from its source on purpose (an
  exclusion, a correction) must make the reconciliation say `explained`, not
  drift — or it will block the next baseline freeze.

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
- **Which way is better is part of the metric, not of the card.** Declare it in
  `packages/core/src/metric-direction.ts`, keyed on `formula_key` — a falling
  cost per funded deal is good news for every client, so it is not a config row.
  `tenant_metrics.improvement_direction` is consulted only for a formula core
  does not declare, and is overridden where they disagree. Nothing defaults to
  `up`: an undeclared formula is neutral and an undeclared *cost* is `down`, so
  a new cost metric cannot render green as it rises. A screen never states a
  direction — `apps/web/test/metric-direction-usage.test.ts` reads the sources
  and fails if one does.
- **A contracted curve is plotted against ramp month until the start month is
  recorded, and on the calendar after.** The contract says what M3 costs; it
  does not say when M3 is, and `engagement_start_month` may be unset — so
  `rampSeries` in `packages/core` pairs M1–Mn with the actuals and never asks
  for an actual while the start month is null. Once it is set, `rampTimeline`
  draws the six months before M1 as the baseline, the start as a marker, and
  the targets on their calendar months (reversed 23 September 2026; see
  `docs/brief-amendments.md`). **A ramp actual is a completed calendar month**,
  gated on its own denominator like any other ratio; the month in progress is
  drawn apart as partial and never compared with a monthly target, and a
  month with no figure is `Not measured` with its reason, never a zero. Each
  ramp chart names the channel its target is contracted for.
- **A ratio has a minimum population, and the metric declares it.** Whether a
  formula means anything below a population is a property of the formula, so it
  is declared in `packages/core/src/population.ts` keyed on `formula_key`,
  beside the function that computes it — along with the noun for the population,
  because "fewer than three" invites "three of what". How large the population
  must be is a judgement about a client's volumes and stays in the
  `min_rate_denominator` config row, which carries two: `render`, the smallest
  denominator the figure may be drawn over, and `minimum`, the smallest it may
  be *compared* against. They are different questions and a figure can clear one
  and not the other. A screen calls `metrics.population()` or
  `metrics.comparable()` with the denominator it actually divided by and never
  names a formula or a floor —
  `apps/web/test/population-gate-usage.test.ts` reads the sources and fails if
  one does. An undeclared count is ungated; an undeclared *ratio* is gated.
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
  time. Every instant a report reads has a tenant-local `date` beside it
  (`occurred_on`, `created_on`, `submitted_on`); filter through
  `stageEventsIn` / `leadsCreatedIn` / `callsIn` / `submissionsIn` from
  `@zeeraa/db`, never `occurred_at` against `${day}T00:00:00Z`.
- **A stage event can be real and not counted.** `stage_events.excluded_reason`
  is set at ingest by the `stage_exclusions` config row (renewals reaching
  Funded); `stageEventsIn` and `countedStageEvent()` filter it. A hand-recorded
  date is `origin = 'corrected'`, from `stage_corrections`, and renders as
  corrected.
- Money is `numeric` in the database and never a float.
- Workspace packages ship TypeScript source. Relative imports are extensionless
  (Turbopack does not map `.js` specifiers onto `.ts` sources).
- Migrations are checked in. RLS policies are hand-written so the exact
  `USING`/`WITH CHECK` clauses are reviewable in the diff.
- **Loading configuration into a hosted database uses a targeted script, not
  `db:seed`.** The seed rewrites every `tenant_config` row from the seed
  constant, so running it against production to load one table would reset
  `engagement_start_month` the day somebody records the real one.
  `load-engagement-targets.ts` is the shape to copy: it touches one table, takes
  `--dry-run` to prove the write lands before committing it, and refuses when a
  prerequisite migration has not been applied. **The dry run is not ceremony** —
  every tenant-scoped table is FORCE RLS'd, so a write by a role holding no
  policy matches nothing, raises nothing and exits 0.
- A new tenant-scoped table must, in its own migration, grant to `zeeraa_app`,
  `enable` and `force` row level security, and create its `tenant_isolation`
  (**FOR SELECT** — membership reads, it does not write), `tenant_admin_write`
  (FOR ALL, `effective_role() = 'zeeraa_admin'`), `job_tenant_isolation` if a
  sync writes it, and `maintenance_access` policies. See migration 0028.
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
- **`vercel.json` lives in `apps/web/`**, the Vercel project's Root Directory.
  Vercel reads nothing above it: at the repository root the crons never
  registered and preflight never ran on a deploy, while both looked verified
  locally. Its schema is strict — an unknown key (a `comment`) fails the
  deploy. `apps/web/test/vercel-config.test.ts` holds all three.
- **The deploy runs `preflight`**, from `buildCommand` in `apps/web/vercel.json`: row
  level security enforced for the runtime role, tenant context transaction-local,
  and no `app.*` function or `public` table owned by a role that can bypass row
  level security. It exits non-zero and `&&` stops the build, so a database that
  cannot enforce isolation fails the deployment instead of serving. Adding a
  check there is how an invariant stops being a note in `docs/state.md` — three
  tables sat misowned for eleven days while the file recommended exactly this.
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
  a soft grey-blue canvas, controls in chrome ink, Inter throughout.
- **Dark rail, light content.** The rail is `--color-chrome`; the top bar is
  light, and its breadcrumb's last item is the page title (the h1 is
  screen-reader only). **Controls are chrome ink** — `--color-primary` is the
  rail's near-black — so a link is told from body text by its underline, never
  by colour: use `.link`. Green and red never mark a sync or a status. **Gold
  marks the active nav item and nothing else** — never body text, a border, a
  chart line, a delta or a badge, because the accent is 2.26:1 on the canvas and
  there is no gold that is both gold and legible on white.
  `apps/web/test/chrome-contrast.test.ts` reads the sources and fails if
  `*-gold` appears outside `components/shell`. This reverses spec v2's "no gold,
  no serif, no black band" for the chrome only — see `docs/brief-amendments.md`,
  "§12 — dark chrome and the Zeeraa mark", for what the numbers decided.
- **Zeeraa is the platform and the client is the tenant**, both in the rail, in
  that order, separated by a hairline. The tenant's identity is never behind a
  menu: Zeeraa staff sit with two competing lenders open in adjacent tabs.
- Every card has surface, radius (12px) and the two-layer shadow. A
  hairline-only panel is not a card in this system.
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
- **A range past a source's last read is unmeasured, not quiet.** Every screen
  that draws synced figures asks `sourcesThrough()` / `coverageFor()` in
  `apps/web/src/lib/coverage.ts` for the sources behind each figure — the
  comparison period included — and renders `notMeasuredReason()` (or
  `NotMeasuredCard`) where the range starts after the last read, and
  `throughNote()` where it runs past it. GA4 and Search Console are bounded by
  what they have published, not by the sync. `windowBuckets` applies the same
  cutoff to every chart. `apps/web/test/coverage-usage.test.ts` fails if a
  screen or the export stops asking.
- **The executive screen defaults to month to date and takes the same
  `DateRangePicker`** (reversed 23 September 2026). Measured figures follow the
  range, beside the last whole month (on MTD) or the equal-length period
  before. The ramp covers the engagement and never reads the range; pacing is
  always this calendar month. **A count from one period is never subtracted
  from a count in the other**; `TwoPeriodKpi` renders both figures and no
  delta. Rates and costs do compare.
- **One date control per page, and it is `DateRangePicker`.** Two date fields
  plus the presets, resolved by `resolveDateRange` in `packages/core` so five
  screens cannot disagree about what `?from=&to=` means. The resolved period is
  always stated in words — a pill saying "90d" does not say *which* 90 days. A
  second period control on the same page is what the hero's 3m/6m/12m toggle
  was, and it went.
- No horizontal page scroll at any width down to 375px. Anything wide scrolls
  inside its own card, and the scroll container needs `min-w-0` or it widens the
  page instead.
- No celebration states anywhere. These screens are a record, not a report card.

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
set -a && . ./.env && set +a && pnpm test        # every value in .env is local
```

`SEED_USERS=yes` creates two development accounts with the password
`zeeraa-development-password`, both flagged to change it on first sign-in. It
refuses against anything but a local database: production accounts are created
on the People screen, so the password is generated and handed over rather than
written in a script.

The isolation suite needs a real Postgres. It is testing properties of the
database; a mock would prove nothing.

`DATABASE_URL` alone is not enough: `organic-isolation.test.ts` reads
`DATABASE_URL_JOBS` through `getJobsDb()`, which has no default and throws.
Sourcing `.env` is the shortest thing that works, and it is safe now — each key
is defined exactly once and points at localhost.

**The production strings live in `.env.neon`, which nothing loads on its own.**
Source it by name, in a shell you then close, and prefer naming the URL on the
one command that needs it. It defines no `DATABASE_URL` and no
`DATABASE_URL_OWNER` on purpose, so `db:migrate`, `db:seed`, `db:reset` and
`mutation-test.ts` stay local even with it sourced. `fixtures.ts` refuses any
non-local `DATABASE_URL*` outright, so a forgotten `source` fails the suite
loudly rather than writing to production — `.env` used to define
`DATABASE_URL_JOBS` and `DATABASE_URL_MAINT` twice, and that is exactly what it
did.
