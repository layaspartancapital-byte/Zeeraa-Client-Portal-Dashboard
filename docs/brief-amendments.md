# Amendments to the build brief

The build brief is the governing specification for this platform. Where the
implementation departs from it, the departure is recorded here with the reason,
so that a reviewer comparing the two can tell a deliberate decision from a
mistake.

> The brief is tracked at `docs/brief.md`, so every amendment below is checkable
> against its source. Section numbers refer to that file.

---

## §5 — Cross-tenant access for Zeeraa admins

**Superseded 17 September 2026.**

The brief said:

> `zeeraa_admin` may set any tenant; client roles only their own.

That wording was implemented literally in migration `0001_rls_policies.sql`:
`app.has_tenant_access()` returned true for anybody holding `zeeraa_admin` in
*any* tenant, whether or not they had a membership row in the tenant they were
asking about.

**The rule now:** a Zeeraa admin may work in a tenant only where a membership
row says so. There is no blanket grant by role. Implemented in
`0002_force_rls.sql`; the comment in `0001` describes what that migration did at
the time and is left as history.

### Why

Three reasons, in order of weight.

1. **It was unauditable.** "Who can read this client's funded volume?" had no
   answer in the database. The grant existed only as a role name on a row
   belonging to some other tenant, so there was nothing to list, nothing to
   review, and nothing to revoke short of demoting the person everywhere.

2. **It contradicted the brief's own stated goal.** §5 opens by requiring that
   cross-tenant reads be impossible at the database level, and the engagement
   promises the client that their data is never combined with another's. A
   standing grant to every tenant is the opposite of that, whoever holds it.

3. **It was a second policy path.** Every other read in the system resolves
   through one question — is there a membership row? — which is a single thing
   to test and a single thing to break. The admin clause was a parallel route
   with different semantics, and parallel routes are where isolation bugs live.

### What it costs

Adding a Zeeraa admin to a client is now a deliberate write rather than an
implicit consequence of their role. It happens through a seed or a
maintenance-gated statement, and it leaves a row. That is the intended
trade-off: joining a client engagement should be a recorded act.

### Covered by

`packages/db/test/tenant-isolation.test.ts`, "a Zeeraa admin holding one
membership" — six cases covering reads, writes, self-granted membership,
`effective_role()` and the tenant switcher.

The mutation `has-tenant-access-blanket-admin` in `scripts/mutation-test.ts`
restores the old clause and confirms those tests fail. If someone reinstates
it, CI says so.

---

## §14 — `SF_USERNAME` is missing from the environment variables

**Added 17 September 2026.**

§14 lists `SF_CLIENT_ID`, `SF_PRIVATE_KEY_BASE64` and `SF_LOGIN_URL` for
Salesforce. The JWT bearer flow also requires the integration user's username,
which becomes the assertion's `sub` claim. Without it there is no flow at all —
the assertion identifies the app but not the user it is acting as.

It is added as `SF_USERNAME`. Worth noting for whoever supplies it: this is the
Salesforce username, which looks like an email address but frequently is not a
real mailbox — integration users are commonly
`something@client.com.integration`. Supplying the person's actual email is a
common and confusing failure, because it produces the same `invalid_grant` as
several unrelated problems.

---

## §12 — `FORCE ROW LEVEL SECURITY`

**Added 17 September 2026**, beyond what the brief required.

The brief required row level security and a non-superuser runtime role. The
implementation also forces it, so the policies bind the role that owns the
tables — a backfill script or a psql session is inside the model rather than
around it.

This required moving migrations and seeds off the superuser onto `zeeraa_owner`,
because a superuser bypasses row level security whatever is set. Without that
change FORCE would have been inert in local development and only real in
production, which is the worst of both.

Crossing tenants deliberately goes through `withMaintenance()`. See the README.

---

## §8 and §9.3 — MQL cannot be measured in this org, and the funnel must say so

**Added 17 September 2026**, after the first probe against the production org.
**Revised the same day**: re-scoped to inbound leads, and re-numbered — this was
first filed against §7, which is the sync schedule. §8 defines `qualified_rate`
and §9.3 puts MQL in the stage flow; those are the sections this touches.

§8 defines `qualified_rate` as leads meeting the tenant's configured minimums
divided by total leads, and §9.3 renders MQL as the second stage of the funnel.
The implementation derives both exactly as written. The amendment is not to the
rule but to what the rule can currently produce.

Every figure here is within the **inbound** population defined by
`tenant_config.lead_exclusion` — 7,196 leads — which is the only population this
platform counts. See §6 below for why, and why an org-wide figure appears
nowhere in this repository.

| Concept | Field | Populated |
| --- | --- | --- |
| monthly revenue | `csbs__Estimated_Monthly_Revenue__c` | 8.8% (635) |
| annual revenue | `AnnualRevenue` | 6.7% (482) |
| time in business | `Time_in_Business_Months__c` | **0.4% (32)** |

MQL needs a revenue figure *and* a time in business, so it is bounded by the
smaller of these. Among the 652 leads that converted to an opportunity, time in
business is populated on **two**.

**The rule now:** the field mapping names all three fields (it did not before),
so the stage is derived from the right source the moment the forms start
capturing them. Until then MQL renders as a blocked dependency in the funnel —
not as a count, and not as zero. `qualifyLead` already returns `null` rather
than `false` when an input is absent, and `qualifiedRate` already reports
`undeterminedShare` separately; this amendment records that for Spartan that
share is currently ~99.6%, and that the stage must therefore not be rendered as
a number at all. The blocked state is a row in `blocked_dependencies`
(`mql_stage`), so unblocking it is a delete rather than a deploy.

### Why not just show the 0.4%

Because `Time_in_Business_Months__c` is not a sample of the population — it is a
selected subset. Every one of the 1,000 most recent populated values is ≥ 12
months, with a minimum of exactly 12. The field is an appended list attribute
filtered to businesses already past the bar, not a question anybody answered. A
qualification rate computed over it would come out near 100% and would be
measuring the list vendor's filter, not Spartan's lead quality.

That is the difference between a low-coverage metric and an invalid one. A low
coverage rate can be shown with its gap beside it. A selected denominator cannot
be shown at all, because there is no honest gap to state.

### What unblocks it

A monthly-revenue and a time-in-business question on the web forms, posting into
the two fields named above. Both are single fields already present in the org —
nothing needs creating, only populating. This is the same class of dependency as
the click-ID fields and renders the same way (§9.5).

---

## §6 — Cold-outreach leads are excluded at ingest

**Added 17 September 2026.**

§6 requires each connector to normalize dates and currency, write a `sync_runs`
row, and surface failures as visible connection health. It says nothing about
*which* records a connector should read, because the assumption throughout is
that a CRM object holds one kind of record. Spartan's Lead object holds two.

**The rule now:** the Salesforce connector ingests only leads that
`tenant_config.lead_exclusion` classifies as inbound. Cold-outreach records are
filtered in the SOQL `WHERE` clause and never read. This is a read-side
exclusion only — nothing in Salesforce is written, modified or deleted, and the
records stay exactly as they are in the org.

### Why

Spartan runs a cold-outreach workstream out of the same org as its inbound
marketing, and the two populations are opposites:

| | cold list | inbound web |
| --- | --- | --- |
| appended firmographics (revenue, time in business, state) | present | almost absent |
| attribution (UTM, click ID, landing page) | absent | present |

Averaged together, a rate describes a population that does not exist. `State`
reads three times higher across the whole object than across the leads this
engagement is about, and `utm_source__c` reads roughly seven times lower;
neither figure is true of either group. That is not a rounding problem, it is a
category error, and it would have set the cut-or-keep threshold for most of the
funnel's slices.

The cold records are also the larger group by an order of magnitude — 46,580 of
53,908 at the time of writing, loaded on 8 September 2026 — so the mixed figure
is mostly a description of a list Spartan bought, presented as a description of
its marketing.

**Org-wide rates therefore appear nowhere in this repository or in the product.**
Where an earlier draft of `docs/salesforce-fields.md` and of the amendment above
quoted them, they have been replaced with inbound-scoped figures. The
comparison is kept here, in prose and without the numbers, because it is the
evidence for the rule and nothing downstream can mistake it for a measurement.

### The rules

Configuration, in `tenant_config.lead_exclusion`, seeded from
`packages/db/seeds/lead-exclusion.spartan.json`. A tenant with one kind of lead
sets `enabled: false` and the same code ingests everything.

| Rule | Criteria | Matched |
| --- | --- | --- |
| `cold_outreach_owner` | `Owner.Name` is `Cold Outreach Holding` | 46,580 |
| `bulk_load_2026_09_08` | created 8 Sep 2026 **and** `LeadSource` is null | 46,580 |

The two currently select the same records, which is deliberate rather than
redundant: the owner rule is the precise one, and the window rule is what
catches a re-load that lands under a different owner. The window rule requires a
null `LeadSource` because roughly one lead in ten that day was a genuine inbound
lead that happened to arrive while the list was loading; a bare date window
would have discarded those.

### Three properties that make it trustworthy rather than merely effective

1. **Unclassified is excluded and counted, never assumed inbound.** A lead
   matching no exclusion rule must still carry a positive inbound signal —
   `LeadSource`, a UTM field, a click ID, a referrer — to be ingested. The
   residue is 132 records: manually created leads, mostly closed unqualified,
   with no source and no attribution. They are genuinely unclassifiable, and
   counting them is the point. **The next bulk load will not match today's
   rules, and it lands here as a number on the sync run rather than as
   unexplained funnel growth.**

2. **Every rule's effect is recorded per sync run**, in `sync_runs.exclusions`.
   Rules may overlap, so the per-rule counts do not sum to the total and the
   payload carries a `rulesOverlap` flag saying so; a view that added them up
   would overstate the exclusion. An exclusion that cannot be audited is
   indistinguishable from a connector quietly dropping records.

3. **The three buckets partition the population exactly.** Measured against the
   org: 46,580 excluded + 132 unclassified + 7,196 inbound = 53,908 considered.
   A record falling through all three would be one the platform ingests without
   meaning to, so the arithmetic is asserted in
   `packages/connectors/test/exclusion.test.ts`.

### A note on the implementation

SOQL's `NOT` is not a general boolean operator — it may only prefix a single
parenthesised expression at the head of a `WHERE` clause, so `NOT (a) AND NOT
(b)` is a syntax error rather than a filter. Every negation is therefore pushed
down to the comparisons by De Morgan, which is what `negatedRuleClause` does.
This was found against the real org, not in review.

### What it costs

The inventory's exact org-wide counting, which its own docstring defends as more
honest than sampling, was not wrong so much as insufficient: exactness does not
help when the population is not homogeneous. `probeLeadFieldInventory` now takes
a scope and every rate it reports is a rate within that scope. An unscoped
inventory is still available and still exact; it is simply not the answer of
record for an org running two kinds of lead.

---

## §6 and §7 — `click_view` is the exception to "never loop per day", and its history expires

**Added 17 September 2026**, before the Google Ads connector was built rather
than after, because the constraint has a clock on it.

§6 says of Google Ads: "GAQL. Requires a developer token and an MCC/manager
account. Quota-limited: batch by date range, never loop per day." §7 sets the
ad-platform sync to a nightly trailing 90-day window.

Both hold for campaign-level spend, which is what `daily_metrics` stores, and
the connector batches those exactly as instructed. Neither holds for the
resource that makes the spend-to-funded join possible.

### The constraint

`click_view` is the only Google Ads resource that exposes a `gclid`. Without it
there is no row anywhere that connects a click Google charged for to the
opportunity it became — campaign-level spend can be divided by funded deals in
aggregate, but no individual funded deal can be attributed to a campaign, and
cost per funded deal cannot be broken down by anything.

It carries two limits that no other resource does:

1. **One day per query.** `segments.date` must resolve to a single day. A
   90-day pull is 90 requests, not one. This directly contradicts §6's
   instruction, and the instruction is right about every other resource.
2. **A 90-day lookback.** Data is available only for the 90 days before the
   query date. Not 90 days from a fixed point — a rolling window.

### Why this is urgent rather than merely notable

The lookback is rolling, so **attribution history is expiring while the
engagement is being built**. Every day that passes without a click pull is a day
of click-to-campaign mapping that becomes permanently unrecoverable. There is no
backfill for it later and no support request that restores it; the data is
simply not served.

Concretely, as of 17 September 2026 the reachable window opens around
**19 June 2026**. Clicks before that are already gone. The Salesforce side is
unaffected — converted leads still hold their `gclid` indefinitely, and 244 of
them do — but a `gclid` with no `click_view` row behind it identifies a click
whose campaign, ad group and cost Google will no longer disclose. The join has a
CRM half and an ads half, and only the ads half expires.

This is a reason to run the first click backfill as soon as the developer token
clears Basic Access, ahead of the rest of the connector and ahead of the
Opportunity click-ID fields. Those can be caught up later; this cannot.

### What the implementation does about it

- **Per-day resumability is a first-class concern, not a retry policy.** A
  90-day backfill is 90 sequential requests against a quota-limited API and it
  will fail partway. `click_ingest_days` holds one row per tenant, platform and
  day, with its status and the count written. The backfill claims pending days,
  and a re-run resumes rather than restarts.
- **Each day is idempotent.** Clicks upsert on `(tenant_id, platform, click_id)`,
  so re-running a day that half-succeeded converges instead of duplicating. This
  is the same rule as `daily_metrics` (§16) and for the same reason.
- **A day that has aged out of the window is recorded as `expired`, not
  `failed`.** The two are different facts: one is a job to retry, the other is a
  hole in the record that no retry will fill. Conflating them would leave the
  backfill retrying 90 impossible requests every night, and would hide the hole.
- **The gap is visible.** Days outside the reachable window render as a blocked
  dependency rather than as zero clicks, on the same mechanism as the funnel's
  cut stages.

### What it costs

90 requests for the first backfill and one per night thereafter. Against a
Basic-level Cloud project (15,000 operations a day) that is not a quota problem
at all; against an Explorer-level one (2,880 a day against production accounts)
the backfill spreads over several nights, which the ledger absorbs without
intervention. Either way it is a duration and failure-mode problem rather than a
quota one, and that is what the resumability is for.

A note on where that limit now lives: Google sunset developer tokens on
9 September 2026, and the API access level is a property of the Google Cloud
project behind the OAuth client rather than of a token. See
`docs/google-ads-credentials.md`.

---

## §8 — `cost_per_funded_deal` is a channel metric, and its denominator is not "funded deals in period"

**Amended 17 September 2026.**

The brief said:

> `cost_per_funded_deal` = attributed spend ÷ funded deals in period

Read literally, that divides one channel's spend by *every* deal that funded in
the period. It was implemented that way, and the first run against real data
showed what it produces: Google Ads spend of $78,873.97 over 21 funded deals,
$3,755.90 — a number that counts organic, referral, sales-outbound and repeat
business in the denominator of a paid-media metric.

**The rule now:** a channel's cost per deal is that channel's spend divided by
the deals attributed to that channel. Deals no channel can claim are reported as
their own count and never enter any channel's denominator. Implemented as
`channelCostPerDeal` in `packages/core/src/attribution.ts`;
`costPerFundedDeal` is that function on the value stage.

### Why

The literal reading has a property that disqualifies it. A channel's cost per
deal computed over all deals improves whenever *something else* improves: a good
month from the sales team, a referral wave, a renewal cycle. It would keep
improving if the channel were switched off entirely, right up to the moment
spend hit zero. A metric that reports "this channel got cheaper" when the truth
is "another channel got busier" is not a measurement, and it is the number the
brief puts in the dark band at the top of the executive view.

### What replaces it

Three figures, always together:

1. **Confirmed.** Channel spend ÷ deals attributed to that channel.
2. **Unattributed deals**, as their own count. Never folded into a denominator.
3. **A plausible range.** `high` is the confirmed figure — none of the
   unattributed deals belong to this channel. `low` assumes every one of them
   does, which is the most generous reading the data permits. The truth is
   inside and usually at neither end, and the width of the bracket is the cost
   of the coverage problem stated in the client's own unit.

The range is a bracket, not a confidence interval. Nothing here models a
probability; it states two bounds that the data cannot rule out.

Deals attributed to a *different* channel are separated from unattributed ones
and excluded from the bracket entirely. Somebody else's deal is not uncertainty
about ours: it can never move this channel's figure.

### Two consequences worth stating

**The numerator is the channel's whole spend**, including spend that resolved to
no campaign. Account-level Google Ads spend is still Google Ads spend, and
excluding it would understate the channel's cost by exactly the portion hardest
to attribute — the same flattery as the denominator problem, in the other
direction. The per-campaign breakdown still divides a campaign's own spend by
the deals attributed to that campaign.

**A deal whose click has aged out still counts for the channel.** A `gclid` is a
Google Ads click by definition, so the channel is known even when the campaign
is not. Such a deal belongs in the channel's denominator and cannot appear in
the per-campaign breakdown. For Spartan today that is the difference between a
denominator of 9 and one of 6, and between $8,763.77 and $13,145.66.

### The same rule at every stage

`stage_conversion_rate(n, n+1)` sliced by channel takes both halves from that
channel: a channel's offer rate is offers attributed to it over leads attributed
to it, never over the total. Enforced by `channelReach` in
`packages/core/src/funnel.ts`, which exists so the filtering is a named
operation rather than a `filter` somebody can forget at one call site.
`unattributedReach` gives deals no channel can claim their own row.
`cost_per_stage(stage)` follows the same rule, being `channelCostPerDeal` on a
non-value stage.

### Blended cost per funded deal is a different metric

Total marketing spend over total marketing-sourced funded deals. It is not this
function with the arguments summed, and it is **not computed yet**: with only
Google Ads ingested, any blended figure would silently be the Google Ads figure
wearing a broader name. It waits until every channel in the engagement is
ingested.

This means the brief's north-star metric (§9.1, the dark band at the top of the
executive view) cannot render as a single blended number today. Per channel it
can, with its range.

---

## §9.2 and §12 — the separation rule is a layout rule too

**Added 17 September 2026. Extends the §8 amendment above.**

The §8 amendment fixed the arithmetic: a channel's cost per deal divides that
channel's spend by that channel's deals, and deals nobody can claim are their
own count. That is not sufficient on its own, because a table puts two numbers
on one line and a reader takes them to be comparable whatever the arithmetic
behind them said.

So the same rule governs the screens.

**Channel-attributed and unattributed figures never share a row.** §9.2's table
is one row per platform, and it now carries an explicit **unattributed row**
that is not a platform. It has deals and funded volume; it has no spend and no
cost per deal, because no channel bought them and assigning them to one would be
the exact error the §8 amendment removed. Those cells render as an em dash with
a reason on hover and in the CSV export, never as zero — a zero in a spend
column is a measurement, and it would say Zeeraa acquired fifteen funded deals
for nothing.

**No total mixes the two.** The brief already said the totals row is "computed,
not summed naively across attribution models". The rule is sharper than that: a
total renders only where the sum is meaningful. Spend sums across channels.
Deals sum across every source, attributed or not, because that is the business's
real total. Cost per deal does **not** sum, and does not divide one total by the
other either — that is blended cost per funded deal, which has its own
denominator and is not computed until every channel is ingested. The cell
renders an em dash and says why.

**Coverage and range are part of the metric, not a footnote.** Every
cost-per-deal figure on screen renders with the deals it is over, the deals it
could not speak for, and its plausible range. Enforced in the type system rather
than by review: `CostPerDealFigure` accepts a `ChannelCostPerDeal` and there is
no prop that takes a plain number, so a bare figure is not something a developer
can render by forgetting something. This is the same mechanism as `Sourced<T>`
in §12 and for the same reason — a number whose limits are not visible is read
as a number that has none.

The executive view's north-star band (§9.1) consequently shows one channel's
cost per funded deal, named as one channel's, with its coverage and range. It
does not show a blended figure, and it says so rather than leaving the absence
to be inferred.

---

## §12 — replaced in full by design spec v2

**Superseded 18 September 2026.**

§12 of the brief specified a light, ledger-like workspace: a black-and-gold
identity reduced to a signal, IBM Plex Sans with a high-contrast serif for two
figures, panels made of hairline rules and whitespace, no shadows except on a
modal, and provenance carried as a visual register.

**That section is now superseded in full by design spec v2**, issued by the
client after reviewing the built screens. The direction it sets is a modern SaaS
analytics dashboard: a fixed left sidebar, elevated white cards on a soft
grey-blue canvas, one confident blue, Inter throughout, a mini chart on every
KPI card, green and red deltas, and dense multi-column grids.

Where the two disagree, v2 wins. The tokens, type, structure, chart rules and
motion rules in §12 no longer describe the product.

### What survived, and why it is not styling

Spec v2 §1 keeps a set of rules explicitly, and they are the ones this codebase
enforces in types rather than in review:

- Channel-attributed and unattributed figures never share a row and never sum
  into one total. Still `ChannelRow` and `UnattributedRow` as separate shapes;
  still three render paths in `PerformanceTable`.
- A cost-per-deal figure carries its coverage and its range. `CostPerDealFigure`
  still takes a `ChannelCostPerDeal` and still has no prop that accepts a plain
  number. What changed is the shape of that context: two paragraphs became one
  line plus an ⓘ.
- A blocked or unmeasured stage renders as a state, never as zero.
- Direction comes from each metric's `improvement_direction`, never hardcoded.
- Recent unsettled data is marked provisional.
- Responsive to 375px, keyboard accessible, WCAG AA, print stylesheet, CSV
  export.

### Where v2 is followed with a stated exception

Four places, each because following v2 literally would put a number on screen
that the data does not support.

1. **No target line on the executive hero.** v2 §6 asks for the target as a
   dashed line labelled at the right edge. Both of Spartan's candidate targets
   carry `needs_reconciliation`: the engagement paperwork states cost per funded
   deal two ways. A dashed line across a chart reads as a commitment somebody
   made, so none is drawn, and the reason is a row in the data-quality card.
   `Metrics.target()` returns null for an unreconciled metric, so this is not a
   decision a call site can forget.

2. **Some deltas render as a stated absence rather than a percentage.** v2 §6
   puts a delta on every KPI card. Paid media was first ingested on 2026-06-20
   and the CRM sync reaches back to 2024-08-05, so the ninety days before the
   current window are a valid baseline for funded deals and a meaningless one
   for spend — the account was spending and nobody pulled it. Comparing against
   it produces `+19,566.7%`, which is arithmetically correct and reads as
   performance. `ingestionStart()` gives the two boundaries and `Delta` takes a
   nullable baseline, so the card says *not ingested before 2026-06-20* instead.

3. **The hero chart's period toggle is in months, not 30d/90d/12m.** The north
   star is a ratio with one or two funded deals in its numerator each month.
   Bucketed weekly it is a line that is mostly gaps; a 30-day version of it is
   two points. The page's own date-range control still offers 30d/90d/365d and
   drives every figure; the hero toggle chooses 3, 6 or 12 months of trend.

4. **"Month-over-month change" compares the last two complete months.** v2 §7
   puts a month-over-month diverging-bar chart on the performance screen. Today
   is the 18th, so the current month against the previous one reports a collapse
   in every volume metric that has not happened. The card names the two months
   it used. Its bars are percentage change, because five metrics in four units
   cannot share an axis, and each bar's colour comes from that metric's own
   improvement direction — paid media spend has none configured and stays blue.

### Not built

- **No donut anywhere.** v2 §6 permits one per screen for share-of-total
  composition; §7 assigns a specific chart type to every slot and none of them
  is a donut. Share of total is carried by the coverage bars in the channel
  snapshot and by the stacked bars, both of which keep channel and unattributed
  segments visibly separate.
- **The workspace board is empty.** v2 §7 describes kanban cards with type
  badges, assignees, comment counts and versions. The columns, the drop zone and
  the activity rail are built and read from `assets`, `asset_comments` and
  `asset_types`; uploads, versioning, mentions and the approval flow are phase 5,
  so the board renders with real (zero) counts and invents no cards.

---

## §5 and §12 — the policy helpers no longer elevate

**Superseded 18 September 2026.**

`0002_force_rls.sql` gave the SECURITY DEFINER policy helpers a function-level
`SET app.maintenance = 'on'` so they could read `memberships` while FORCE bound
their owner. That mechanism cannot be deployed to a managed Postgres.

Attaching a `SET` clause for a *custom* configuration parameter requires `SET`
privilege on that parameter, and only a true superuser may grant it. Neon gives
you none — `neondb_owner`, a member of `neon_superuser`, is refused:

```
grant set on parameter app.maintenance to zeeraa_owner;
ERROR:  permission denied for parameter app.maintenance
```

Verified against the live instance, not inferred. The same refusal applies to
`ALTER DATABASE ... SET` and `ALTER ROLE ... SET`, so the parameter cannot be
pre-declared into existence either. Migration 0002 therefore aborted partway and
the chain never completed. A recognised parameter is unaffected: `set
search_path` in a function definition works, and a *session-level*
`SET app.maintenance` works for any role, which is why `withMaintenance()` is
untouched.

### The rule now

The helpers read **`app.membership_index`** — an authorisation-only mirror of
`(tenant_id, user_id, role)` — and carry no parameter SET clause at all.

- It lives in `app`, not `public`. It is not tenant data, and it is outside the
  sweep `assertRlsEnforced` runs over `public`.
- **No application role holds any privilege on it.** `zeeraa_app`,
  `zeeraa_auth` and `zeeraa_jobs_runner` cannot read or write it. Privileges are
  checked before policies, so this is the primary control, not the policy.
- Row level security is enabled on it with no permissive policy, behind that, as
  defence in depth.
- It is maintained synchronously by SECURITY DEFINER triggers on
  `public.memberships`, in the writer's own transaction — including an
  `AFTER TRUNCATE` statement trigger, which is the one write a row-level trigger
  never sees. Access therefore remains answerable from `memberships` and
  revocable there, which §5 requires.

### Why not the two obvious alternatives

Both are pre-declared regressions by `scripts/mutation-test.ts`, which is the
codebase's own statement that they were considered and rejected:

- **`set_config()` in the function body** is the mutation
  `definer-elevates-in-body`. The flag would outlive the policy evaluation, so
  any statement later in the transaction could ride it — a caller would get an
  elevated statement for free simply by touching a policy.
- **Dropping FORCE** so the owner reads `memberships` directly is the mutation
  `unforce-opportunities`. It puts a psql session back outside the model.

A third option — owning the helpers with a `BYPASSRLS NOLOGIN` role, which Neon
does permit — was rejected on the merits rather than by the test suite. It
requires `zeeraa_owner` to hold `SET` on a role that ignores every policy in the
schema, which is one `SET ROLE` away from exactly the blanket, unauditable
cross-tenant access the first §5 amendment was written to eliminate, and it does
not grep.

### What did not change

FORCE still binds the owner on all 38 tables in `public`. `maintenance_access`
is still conditional on the flag. No role anywhere gains `BYPASSRLS` or
`SUPERUSER`. The helpers are still SECURITY DEFINER, still pin `search_path`,
and still return a boolean or a role name rather than rows.

### The test that changed, and the ones that were added

`test/force-rls.test.ts` asserted that every SECURITY DEFINER function in `app`
carried `app.maintenance=on` in `proconfig`. That assertion encoded the
mechanism, not the guarantee, and under the new design it would require an
elevation that has deliberately been removed. It is replaced by a strictly
stronger one: no such function carries the flag **and** none calls `set_config`
in its body **and** every one pins `search_path`.

Because the new mechanism has a failure mode the old one did not — a mirror can
drift, or be granted away — two tests and two mutations were added rather than
taking the change on trust:

| test | mutation it is killed by |
| --- | --- |
| the mirror is unreachable by every application role | `membership-index-readable-by-app` |
| the mirror agrees with `memberships`, with zero drift | `membership-index-drift` |

16 of 16 mutations are killed.

### Both 0002 and 0008 carry this, and neither is redundant

Drizzle's ledger records each migration's journal timestamp rather than a hash of
its contents, so **editing a migration is inert on any database that has already
run it.** 0002 had to change so a *fresh* database can be built on Neon at all;
`0008_policy_helpers_without_parameter_set.sql` restates it so an
*already-migrated* database receives it. Every statement in both is idempotent,
so a fresh database applying them in sequence lands in the same place.

---

## §7 — routine syncing runs on Vercel Cron, not Inngest

**Superseded 18 September 2026.**

§7 put ingestion on Inngest for a concrete reason, quoted from the brief:

> Vercel functions have a hard timeout. Meta's Insights API is
> submit-job-then-poll with waits measured in minutes, and a 90-day first
> backfill across six platforms will exceed any of them.

That reasoning is sound and is **not** what changed. What changed is the
recognition that it applies to the *backfill*, not to routine syncing — and that
paying an Inngest dependency for the routine path bought nothing while costing a
deployment step that was never completed. `/api/inngest` returned
`In cloud mode but no signing key found` in production, so nothing was syncing
on any schedule at all.

### The rule now

**Hourly incremental sync on Vercel Cron.** `vercel.json` schedules
`/api/cron/sync` at `0 * * * *`. It calls `runIncrementalSync` in
`packages/jobs/src/incremental.ts`, which is sized for a 60-second function and
measured at 5–7 seconds against Spartan:

| | |
| --- | --- |
| Google Ads | 2-day window for spend *and* `click_view` |
| Salesforce | records modified since its last completed read |
| Observed duration | 5.4s (43 campaigns, 12 metric rows, 2/2 click days) |

Two days rather than one is the smallest window that absorbs a restatement of
yesterday plus a missed run. It upserts exactly as the ninety-day window does,
so nothing double-counts — the "never append to `daily_metrics`" rule is what
makes a short window safe.

**The backfill stays a script.** `scripts/run-scheduled.ts` and the per-platform
scripts re-pull the full ninety days from a machine with no request timeout.
Ninety days of `click_view` is ninety sequential requests; it does not fit in a
function and never will. When Meta arrives, its submit-then-poll flow belongs
there too, or behind something durable — §7's argument, in its proper scope.

### Salesforce is skipped rather than attempted when the window is too wide

A first run, or a run after a long outage, is a full pull of tens of thousands
of records. Starting one inside a 60-second function would time out, leave a
`running` row in the ledger, and be retried on the hour forever. So the endpoint
reads the change window first and, if it is missing or older than 26 hours,
reports `skipped` with the script to run. `skipped` is a first-class outcome in
the response and in the UI, not a soft failure.

**The watermark had to be corrected for this to be incremental at all.**
`runSalesforceSync` derived its window from `lastSuccessfulWatermark`, which
requires `status = 'succeeded'`. Spartan's Salesforce sync reports `partial`
permanently, for one field that does not exist in the org — so the watermark
never advanced, and every "incremental" run would have been a full pull of
54,000 leads. `lastCompletedWatermark` accepts `succeeded` *or* `partial`,
because `partial` here means a named field was dropped from the query while the
records in the window were still fully enumerated. `failed` is still excluded: a
run that threw may have read nothing, and advancing past it would skip records
permanently. The existing helper is untouched, so the nightly and the manual
scripts behave exactly as before.

### A latent SOQL bug this surfaced

`buildBackfillQuery` interpolated `ConvertedDate >= ${since.toISOString()}`.
`Lead.ConvertedDate` is a Date, not a DateTime, and SOQL rejects a timestamp
literal against it — a 400, not a retryable failure. It only fired when a caller
passed `since`, which until now only happened behind an explicit `--since` flag.
The hourly endpoint passes it every run, so it failed every run until fixed to a
bare `YYYY-MM-DD`. Truncating to the day widens the window by up to 24 hours,
which is the safe direction for an idempotent upsert. Now pinned by
`packages/jobs/test/backfill-query.test.ts`.

### Authentication

`CRON_SECRET` as a bearer token, compared with `timingSafeEqual` and
length-guarded. A deployment without `CRON_SECRET` set returns 503 and runs
nothing — an unauthenticated sync endpoint that works is worse than one that
does not, because it lets a stranger spend the client's API quota. An
unauthorised request gets 404 rather than 401: an endpoint that must not be
reachable should not confirm that it exists.

The "Sync now" button does not use the bearer. It posts to
`/api/sync/{tenant}`, which is session-authenticated and `zeeraa_admin`-gated
via `requireRole`, and which calls the same `runIncrementalSync` scoped to one
tenant. It waits for the result and reports the real per-platform outcome,
duration and remedy, instead of reporting that an event was queued.

---

## §8 and §9.3 — three of the four unmeasured items are now measured

**Added 18 September 2026.** This supersedes the conclusion of "§8 and §9.3 —
MQL cannot be measured in this org" above, and extends §9.3's stage flow. The
earlier entry is left in place because its reasoning still holds for the fields
it examined; what it got wrong was treating those fields as the whole of the
evidence.

Four things rendered as `Not measured`. Three turned out to be recoverable from
data already in the org, and the fourth genuinely is not:

| | Was | Now |
| --- | --- | --- |
| UW approved | blocked — `csbs__Approved_Date_Time__c` empty on every opportunity | 114 in the trailing 90 days, from field history |
| Offer rate | blocked, because its denominator was | 58.8% (67 of 114) |
| MQL | blocked — the two numeric inputs are ~0.4% populated | 649 in the window, 57.6% of leads assessable |
| Decline volume and timing | folded into "decline reasons", blocked | 362 deals, 389 transitions, monthly series |
| Decline reasons | blocked, reason given as "sparse" | still blocked, with the real reason |
| Revenue bands | blocked | still blocked, and correctly so |

### UW approved comes from `OpportunityFieldHistory`, not from a stamped field

Field history tracking is on for `Opportunity.StageName`, and the approval
transitions are in it: 119 events across 115 opportunities. The retired
picklist values are handled by a value-alias map in
`packages/connectors/src/salesforce/stage-history.ts`, which maps every label
ever observed to a funnel stage key or to `null` for
recognised-but-not-emitted. An unrecognised label is counted and reported
rather than dropped silently, so a new picklist value shows up as a number in
the sync record instead of as a quiet undercount.

**History has a horizon, and the horizon is part of the metric.** Nothing in
`OpportunityFieldHistory` predates **2026-03-20**, because that is when
tracking was switched on. The stage is complete inside that window and silent
before it, which is a different statement from zero. The funnel renders
`from 2026-03-20` on the figure itself — not in a footnote — for exactly the
stages whose only source is history. `HISTORY_SOURCED_STAGES` in
`apps/web/src/lib/reporting.ts` holds that set, and `declined` is deliberately
not in it: it has a stamped field as well, and the field reaches further back
than tracking does.

### Decline: how many and when is a different question from why

Splitting them is the whole point. "Why are we losing deals" could not be
answered, and that was allowed to suppress "how many did we lose", which could
be answered all along from `csbs__Declined_Date_Time__c` and the Declined
transitions — 89% coverage of closed-lost deals between them.

**Volume is a deal count, not an event count.** 362 deals declined in the
trailing 90 days across 389 transitions into Declined. The gap is
re-underwriting: a deal declined, revived and declined again is one deal and
two transitions, and both numbers are on screen because a reader comparing this
card against a CRM report will otherwise hit the difference and distrust the
screen.

**There is no decline rate.** Deals declining in a window include deals that
applied before it, so dividing the two window counts compares two cohorts — it
came out at 124.7%. A real decline rate follows one cohort forward and is a
different query; until it exists the card shows a volume and says why there is
no share.

**Decline reasons stay blocked, with the true reason.** `Loss_Reason__c` was
filled in on *every* closed-lost opportunity through January 2025 — 68 of 68
that month, 23 of 23 in December 2024 — and then abandoned: 0 of 133 in July
2026, 2 of 132 in August, 1 of 66 in September. That is a process change to
raise with the client, not sparse data to design around, and the blocked state
now says so. `csbs__Decline_Reason__c`, which the mapping asked for, does not
exist in the org at all.

### MQL: the answers are there, in bands

The earlier amendment measured `csbs__Estimated_Monthly_Revenue__c` (8.8%),
`AnnualRevenue` (6.7%) and `Time_in_Business_Months__c` (0.4%) and concluded
the bar could not be evaluated. What it missed is that the forms mostly do not
ask for numbers — they ask for a **band**, and the answers are in picklist
fields the connector was not selecting. So the primitive is a band reader:

`packages/core/src/bands.ts` turns a literal into an interval and compares the
interval with the bar three ways — passes, fails, or **straddles**. A band that
contains the threshold is `undeterminable`, never a pass and never a fail:
`$10K - $25K` against a $10,000 bar is not an answer, and rounding it either
way would be inventing one. 215 leads (4.3% of the 5,049 with both inputs
present) sit in such a band.

Two parser bugs are worth recording because both produced plausible wrong
answers rather than errors:

* **Zero was being dropped** as falsy, so `0 - 1 Years` collapsed to a point
  value of one year and *passed* a twelve-month bar.
* **The unit suffix matched a prefix**, so the `m` in `< 12 Months` read as
  "million" and the band became twelve million months. Fixed with a word
  boundary; 34 tests in `packages/core/test/bands.test.ts` are built from
  literals taken out of the live org, including `&lt; $10,000`,
  `Menos de 15.000 dólares` and `x12_Months_plus`.

**The verdict is stored; the resolved number is not.** Migration 0009 adds
`leads.mql_verdict` (`qualified | unqualified | undeterminable`) and
`leads.mql_undeterminable_reason`. Band resolution stays in the connector,
which is where every other field mapping lives, and `self_reported_revenue`
keeps *no* value for a banded answer — writing the low end of `$10K - $25K`
into a numeric column would create a $10,000 figure that no lead ever stated
and that every downstream average would treat as measured. A band is evidence
about a threshold, not a quantity.

`mql_verdict` being null means the bar has not been run, which is not the same
as `undeterminable` and is not counted as it: the writer coalesces rather than
overwriting a stored verdict with a null one, the reason travels with the
verdict it belongs to, and the funnel names the unevaluated share separately.

**What the bar now says, over 7,296 inbound leads:** 1,206 qualified (16.5%),
2,903 unqualified (39.8%), 3,184 undeterminable (43.6%). The largest single
obstruction is `MIYB_Years_in_Business__c` — 1,075 leads whose only
time-in-business answer is in a field whose values are opaque codes. It is
declared unusable pending a decode key rather than guessed at, and that is the
one remaining blocked dependency on MQL. `New Business` and `Not Started`
*fail* the time-in-business test rather than being undeterminable: a business
that has not started has not been trading for twelve months.

**MQL never renders as a bare count.** The stage carries
`57.6% of leads assessable` and an ⓘ giving the three verdict counts and the
top obstruction. A count of qualified leads without its coverage implies the
other 42.4% were assessed and failed.

### MQL is counted at lead grain, and that was a second bug

An MQL stage event is stamped against an opportunity, so counting the stage
from `stage_events` counted the qualified leads that went on to convert — 26 of
649 — under the label MQL, and divided *that* by every inbound lead to report a
qualification rate of **0.7%** against a measured **17.0%**.

A qualified lead is a judgement about a lead, so migration 0010 adds
`qualified_leads` as a third value for `funnel_stages.source`: the `leads`
population narrowed by one predicate. Configuration, not a branch on the word
"MQL" — a tenant whose second stage is a different judgement declares it the
same way.

**Nesting is now declared rather than inferred from the arithmetic.** A
conversion rate presumes the later population is drawn from the earlier one,
and the funnel used to test that by checking whether the ratio exceeded 100%.
That test caught MQL → Application while MQL was at the wrong grain (1,696%).
At the right grain the same transition reads 441 of 649 — 68%, comfortably
under 100%, and still not a conversion rate, because the bar is computed from
what a lead reported rather than being a gate it passes through: a lead that
misses the bar can and does still apply. So a stage sourced from
`qualified_leads` declares that the stage after it is not drawn from it, the
rate renders as an em dash, and the ⓘ says which of the two reasons applies. A
guard that only fires when the arithmetic embarrasses itself is not a guard.

### A related correction: stage counts were deal-days, not deals

The bucket query selects distinct `(day, stage, opportunity, platform)`, so a
deal reaching a stage on two days inside one month arrived twice. For stages
that do not recur this never showed; for declines it inflated the window total
to 555 against 362 actual deals — partly through double counting and partly
because the window total summed every month that *overlapped* the range rather
than the range itself. Buckets now count one deal once per stage per bucket,
and a window total is a distinct count over the window rather than a sum of
bars.

### Revenue bands stay blocked, and two fields must not be used

`Approved_MCA_Amount__c` and `Net_Funding_Amount__c` report as 100% populated
and hold **six** real values between them; the rest is a default. They are
named here because a population check passes on them, which is precisely how a
default gets mistaken for data. Nothing in this repository reads them.

### What each unblocked item cost in configuration

Nothing client-specific entered the code. The alias map and the band literals
are connector configuration, the qualification bar and the decode dependency
are `tenant_config` rows, the stage grain is a `funnel_stages` column, and
`min_rate_denominator` — added because an offer rate computed over one approval
reported a −70.6% regression — is a config row read by the delta logic.

---

## §8 — Offer rate is blocked, because it was measuring data entry

**Added 18 September 2026**, after a read-only audit of the org prompted by the
figure looking too high for MCA. It was: 58.8% (67 of 114).

§8 defines offer rate as `stage_conversion_rate('uw_approved', 'offer')` and the
implementation computes exactly that. The amendment is that in this org those
two stages are **the same event**, so there is no transition between them for a
deal to fail.

**Evidence.** For the 112 approved deals that hold a `csbs__Offer__c` record,
the gap between the transition into `Approved` and the first offer record has a
median of **0.0 hours**; 110 of 112 fall within an hour, and in 98 cases the
offer record already exists when the stage changes. The deal is moved to
Approved *because* a lender offer arrived.

What the rate therefore measured is whether somebody typed a date into
`Offer_Received_Date_Time__c`. 112 of 115 approved deals hold an offer record;
57 hold the field. It is a field-completion rate wearing the name of a
conversion.

**A second, independent defect.** The two populations do not nest: 10 of the 67
offers in the window belong to deals with no approval event at all. 67/114 is
58.8%; the nested figure is 57/114, or 50.0%. The extra 8.8 points are deals
the denominator does not contain.

**And offer is not a state a deal stays in.** Of the 125 deals holding an offer
record, 88 are currently lost — 55 Declined by Lender, 31 Closed Lost, 2
Declined in Final — and 21 funded. 46 of the 67 in-window offer deals have a
decline *after* their last offer. A funnel stage that deals leave backwards is
not a step in a monotonic sequence, which is recorded separately.

### How it is blocked

A `metric` row in `blocked_dependencies` against `offer_rate`, not a blocked
stage: both stages are measured, and it is the metric over them that does not
mean what its name says. That distinction is now expressible —
`loadMetrics` returns `blocked(key)`, and a metric-level block outranks the
stage check on the KPI cards.

**One row retires the figure everywhere.** The same 58.8% also rendered as the
funnel's connector chip between UW approved and Offer. A blocked metric whose
formula is a stage conversion rate names the two stages it spans, so the funnel
suppresses that transition from the same row. Blocking a metric on one screen
and leaving the identical number on another is how a retired figure survives.

**What replaces it** is a submission-level rate from `csbs__Submission__c`:
offers received over decided submissions, which measures 18.2% across 131
offered and 590 declined — the figure the deal-level rate was standing in for.
