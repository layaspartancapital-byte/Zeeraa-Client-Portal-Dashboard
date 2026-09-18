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
