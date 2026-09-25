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

## §12 — the chart palette, and the line between data and controls

**Amended 22 September 2026**, alongside the chrome. Spec v2 §4's categorical
palette is replaced. The aesthetic was the smaller half of the reason.

### What was wrong with it, in numbers

- `#06B6D4`, `#F59E0B` and `#10B981` were **2.26, 2.00 and 2.37** against the
  canvas — under the 3:1 WCAG 1.4.11 asks of a graphical object. Three of six
  series were failing before anybody mentioned the brand.
- `#F59E0B` was dE 8.8 from `--color-warn`, so a channel could be drawn in
  almost exactly the colour that means *Not measured*; `#10B981` was dE 11.6
  from `--color-up`, so a channel could be drawn in the colour that means
  *improving*.
- `#3B5BDB` and `#7C3AED` were **dE 6.6 apart under deuteranopia** — the same
  colour, in the two slots that hold Google Ads and Meta Ads, which every
  comparison on the page puts side by side.

### The constraint that shaped the replacement

Red, green and gold now carry meaning — direction, and the nav accent — and they
are excluded **by hue rather than by distance**. A dark sage is far from
`--color-up` in dE and still reads as good news on a bar.

That leaves the teal-blue-violet-plum arc, and it is too narrow for six hues to
survive colour blindness. So the palette **separates by lightness as much as by
hue**, which is why hand-tuned sets kept failing where a constrained search
succeeded: when the hues collapse, the lightness ladder still reads.

```
1  #242B3A  ink          L17   13.21:1
2  #661F75  purple       L30    9.70:1
3  #3985FF  blue         L56    3.28:1
4  #3641AB  indigo       L35    7.83:1
5  #8079C0  periwinkle   L54    3.62:1
6  #9C6B89  rose         L51    4.01:1
```

Worst-case separation **23.8 dE across normal vision, protanopia, deuteranopia
and tritanopia**, against 6.6 before. Nearest any series comes to `--color-up`
or `--color-down` is dE 67.7. `apps/web/test/chart-palette.test.ts` re-derives
every one of these numbers rather than restating them, including the
colour-blind simulation.

**Direction is untouched.** Rising cost is red and falling is green, as each
metric's `improvement_direction` defines it. The rebrand does not get a vote on
that, and a test asserts the two hex values directly.

### The line this drew: controls are blue, data is ink

`--color-primary` dresses buttons, links, segmented controls, focus rings and
badges. `--color-plot` dresses series, inline bars and markers. They were the
same colour until now, which is exactly how a distinction like that goes
unnoticed — and it meant the rebrand could repaint every chart without touching
a single button.

Three inline marks moved with the charts, because a bar in a table is data:
`Progress`, the citation bar in `DeclineCard`, and the optimisation-target dot
in `PerformanceTable`.

### Sign-in and the forced password change

They sit outside the shell, so they had no rail and no title band and carried no
identity at all — while being the first thing anyone sees. `AuthShell` gives
them the same division as everywhere else: **near-black page carrying the mark,
light card carrying the form**. The fields stay on `--color-surface` because a
password field on near-black is a worse password field, and these are the two
screens where a mistyped character costs the most.

Their submit buttons stay `--color-primary`, along with every other button in
the product. The blue is the control palette, and it is not what the rebrand
replaced.

---

## §12 — dark chrome and the Zeeraa mark

**Amended 22 September 2026.** Spec v2 §4 says "no gold, no serif, no black
band". That is now reversed for the chrome, and unchanged everywhere else.

The reason it was written stands: a gold-on-black treatment applied to a
workspace makes the numbers hard to read for an hour at a time, and most golds
fail contrast on light ground and read as cheap. What changed is the scope. The
platform has an identity — a gold enso and wordmark on black — and it has to
appear somewhere. Confining it to the chrome keeps the reason the rule existed
while letting the product be branded.

### The rule that replaces it

**Dark chrome, light content.** The rail and the title band are
`--color-chrome` (`#14161A`, near-black rather than black). Cards, tables and
charts stay on the canvas they were designed for. Nothing about the content area
changed.

**Gold marks the active navigation item and nothing else.** Not body text, not a
border, not a chart line, not a delta, not a badge. `apps/web/test/chrome-contrast.test.ts`
reads the sources and fails if `*-gold` appears outside `components/shell`, and
fails separately if the word appears anywhere under `components/charts`.

The arithmetic behind the rule, rather than a preference for it: the accent is
2.26:1 on the canvas and 2.03:1 on a card. There is no gold that is both
recognisably gold and legible as type on white.

### Three things the numbers decided

- **The accent is `#C9A227`, not the logo's `#A77F41`.** The sampled value is
  4.96:1 on the chrome but **4.42:1 on the active row's raised background**, so
  the row could not have both a fill and a gold label. The lifted value clears
  both at 7.49 and 6.67. The asset keeps its own colour; this is the interface's.
- **The tenant mark gained a hairline ring.** Spartan's `#2F5D8C` is 2.64:1
  against the rail, under the 3:1 WCAG 1.4.11 asks of a graphical object, so the
  square read as a hole. The ring clears the bar whatever colour is behind it,
  which fixes every tenant rather than asking each to re-pick.
- **`tenants.accent_color` no longer defaults to a gold.** It defaulted to
  `#8A6B1F`, chosen when the brief still described a black-and-gold identity. A
  tenant created without an explicit colour would have been handed a mark in
  nearly the platform accent, three rows above the thing that accent means.
  Migration `0023`.

### Where the platform and the client meet

Zeeraa is the platform; the client is the tenant; both are in the rail, in that
order, separated by a hairline. Reading order carries the hierarchy, so neither
has to be subordinate in colour — which matters because the tenant's identity is
never allowed behind a menu. Zeeraa staff sit with two competing lenders open in
adjacent tabs.

The role line lost its ` · Zeeraa` suffix in the process. It existed to say which
side of the engagement the reader is on, the wordmark two rows above now says
that, and together they rendered as "Zeeraa admin · Zeeraa".

### What the top bar did not become

The title band is chrome; **the page's controls sit below it on the canvas**.
Date fields, selects and buttons on near-black would have meant rebuilding every
form control in the shell for one band, and the light versions are the ones this
product has already got right. The seam sits above the controls rather than
below them.

### Two exceptions worth naming

- **The wordmark is a serif**, and spec v2 bans serifs. It is the brand asset
  rather than interface type; Inter still sets every word the product writes.
- **The mark is brightened** by `brightness(1.3)` in `ZeeraaMark`. The file's
  wordmark is a darker bronze than its enso and was drawn for print. Most of the
  legibility came from size rather than brightness — the wordmark is a thin
  serif and its strokes go sub-pixel below about 30px. **An SVG would fix this
  properly** and is worth asking the client for: it would render crisply at any
  size and let the ring and the word carry their own values, where a raster has
  one filter for both.

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

---

## §4, §8 and §9.3 — submissions are the grain the funnel was missing

**Added 18 September 2026.** The brief models the pipeline as a deal moving
through stages. For an MCA broker that is one level above where the business
happens: a deal is submitted to several lenders at once — Spartan's median is
four, its maximum ten — and each lender answers separately. Approve, offer and
decline are *lender* events.

Reading them off the opportunity flattens four answers into one field. That is
what produced a deal-level offer rate of 58.8% where the lender-grain figure is
18.2%, and it is why "which lender declines this profile, and why" could not be
asked at all.

`csbs__Submission__c` was not in the brief's field list. It holds 1,427 records
across 419 opportunities and six lenders, and its `Decline_Reason__c` is the
decline reason that was reported as unrecoverable — on the object it belongs to
rather than the one the brief looked at.

### The table

`submissions`, one row per deal per lender, with the usual treatment: granted
to `zeeraa_app` and `zeeraa_jobs`, RLS enabled and forced, `tenant_isolation`
and `maintenance_access` policies hand-written in migration 0011. Two mutations
and three isolation tests were added with it, because a submission names a
third party's decision about a client's merchant — a leak here would tell one
client which lenders another uses and what they decline.

Three decisions worth recording:

* **The lender is denormalised onto the row.** It is an Account in the CRM and
  this platform has no reason to ingest 25,358 Accounts to label six of them.
  The lender is a dimension, not an entity we own.
* **Decline reasons are an array**, because the source is a multipicklist and
  one lender can cite several for one decline. That makes a reason breakdown a
  count of *citations*, never a share of declines, and the array keeps that
  visible instead of letting a join imply otherwise.
* **`status_changed_at` is named as a proxy.** History tracking on the object
  records only creation, so a lender's decline has no timestamp of its own and
  `LastModifiedDate` is the closest available — any other edit moves it. No
  timing claim is built on it.

### The metric

`submissionOfferRate` divides offers by *decided* submissions — offers plus
declines. 706 of 1,427 are undecided at any moment, and they are carried on the
metric rather than in a caption: a reader who assumes the denominator is every
submission is out by a factor of two. A lender that has not replied has not
declined, and a window where nothing has been decided returns null rather than
zero.

Undecided is broken into its causes on screen, because 693 submissions awaiting
an answer is the pipeline working and 13 that never completed is not.

`offer_rate` is retired by a `metric` row and replaced by `lender_offer_rate` on
the executive and performance screens, with the per-lender table on the funnel.
Per lender, of decided submissions: CFG 34.4%, Spartan Capital 17.1%, Elevate
Funding 11.4%, Forward Financing 5.4%. Both halves of each rate come from that
lender — exactly the rule channel metrics follow, for the same reason.

The card carries no delta. The object begins on 18 June 2026, so there is no
comparable previous period; an arrow drawn against a partial first month would
be a statement about when the object was switched on.

### Decline reasons: unblocked at lender grain, still blocked per deal

Reasons are measured, from `Decline_Reason__c`: 123 citations across 121 lender
declines, with the 16 values the picklist offers. **Coverage is rendered per
month and never summed**, because the field is being adopted rather than used —
0% of June's declines, 15.4% of July's, 9.1% of August's, 30.5% of September's.
An all-time 20.5% would average an unused field with an adopted one and describe
neither month, so no function in `packages/core` returns one.

What stays blocked is a reason *per deal*. `Loss_Reason__c` is abandoned, and a
deal declined by three lenders for three different reasons has no single reason
in the CRM. The platform does not choose one. The blocked row was re-scoped
rather than deleted, because a deal-level composition is exactly what a reader
will assume the lender chart shows.

`csbs__Decline_Reason__c` was dropped from the Opportunity mapping at the same
time. It was kept deliberately while the reason was unmeasured so
`validateMapping` would keep reporting it; now that the reason is read where it
lives, a permanently absent field would leave the connection `Degraded` and
every sync `partial` for a gap that is closed — the fastest way to make a real
warning invisible. The sync reports `succeeded` again.

### §9.3 — the funnel no longer assumes stages progress in order

The stage flow draws stages left to right and puts a conversion rate on each
connector. That asserts two things this data does not support, and both are now
measured per transition rather than assumed:

**That the later population came through the earlier one.** It does not always:
1 of 114 approved deals has no underwriting timestamp, 10 of 67 offers have no
approval event at all, and 9 of 21 funded deals have no recorded offer.
`progression` counts the overlap from the stage events, and the two cases need
different answers — suppressing a rate over one stray record in 114 replaces a
figure that is right to a tenth of a percent with an em dash, while rendering
one whose numerator is a seventh strangers is the error this audit was about.
So the line is `max_rate_leakage`, a config row, defaulting to 2%: above it the
rate is withheld with the count, below it the rate renders and the ⓘ states what
it leaves out.

This is the check that would have caught the offer rate without anybody noticing
the figure looked high.

**That a deal which reaches a stage stays reached.** It does not: 47 of the 67
deals reaching Offer in the window were declined afterwards, and of the 125
deals holding an offer record, 88 are lost and 21 funded. A funnel drawn left to
right cannot show a deal going backwards, so each stage card states how many of
its deals were later declined. Reading the Offer column as live pipeline would
overstate it threefold.

---

## §7 — planned: a direct Aloware connector, not `Aloware_Call__c`

**Added 18 September 2026.** The org inventory turned up 30,093
`Aloware_Call__c` records — one per call, linked to a `Lead`, carrying
`Direction__c`, `Disposition__c`, `Duration_Sec__c` and a recording URL, and
running at 12,000–15,000 a month since June 2026. Call tracking currently
renders as `Waiting on client — vendor not selected`, which is wrong: the vendor
is Aloware and it is live.

**It is deliberately not being read from Salesforce.** A Salesforce custom object
fed by a vendor's integration is a copy whose completeness depends on that
integration's own sync, and this platform would be inferring call outcomes from
whatever the middle layer happened to write. Call tracking will be a direct
Aloware API connector, like Google Ads and Salesforce: its own `connections`
row, its own credentials, its own `sync_runs` ledger and its own reconciliation.

Until that connector exists the blocked state stays, and its reason should be
corrected from "vendor not selected" to name Aloware and the planned connector.
That correction is not made here because it belongs with the connector work
rather than in a commit about submissions.

---

## §7 and §9 — call tracking, from Aloware directly

**Added 18 September 2026.** Supersedes the planned-work note above it, which
is now built, and corrects a blocked state that had been wrong for months.

Call tracking rendered as `Waiting on client — call tracking vendor not yet
selected`. The vendor was selected: Aloware is live and has been writing
12,000–15,000 calls a month since June 2026. The blocked state was describing
the engagement rather than the org, and nobody looked again once it was
written.

### Not from `Aloware_Call__c`

The Salesforce org holds 30,093 `Aloware_Call__c` records, linked to leads,
with direction, disposition, duration and a recording URL. Reading those would
have been a day's work instead of a week's, and it is the wrong source: that
object is a copy whose completeness depends on the vendor's own Salesforce
integration, so a gap in that integration would be indistinguishable here from
a quiet day on the phones. A metric this product publishes should not rest on a
third party's sync of a third party.

So calls come from Aloware: an export for the history, a webhook for
everything after it, both through one normaliser, both upserting on Aloware's
**Communication ID**. That key is what lets the two routes coexist — the seam
of every export overlaps the webhook, and a re-delivery or a re-import lands on
the same row.

### What the import found

29,115 rows in the export: **28,863 calls** and 252 SMS, which are skipped by
`Type` and counted rather than silently included. 19 June to 17 September. No
row was dropped and no disposition went unrecognised.

**`completed` is not a conversation, and this is the finding that matters.**
The vendor marks 26,311 of the 28,863 calls `completed`, which would be a 91%
connect rate on outbound dialling. The talk time says otherwise:

| Talk time of a completed call | Calls |
| --- | ---: |
| 0s | 2,956 |
| 1–9s | 13,376 |
| 10–29s | 6,476 |
| 30s+ | 3,503 |

So `connected` requires talk time past a threshold, and the threshold is a
config row (`aloware.connectedMinTalkSeconds`, 30s) rendered on the card beside
the figure it decides — because the sensitivity is steep: 23,355 calls are
connected at one second, 9,979 at ten, 3,503 at thirty. A completed call under
the threshold is `attempted` and flagged `answered_briefly`, so the 19,851 of
them are not lost into a bucket.

**Abandoned is its own outcome** — 2,002 calls the caller ended before anybody
answered. Neither a conversation nor an attempt at one, so it is in neither of
the other counts and outside the connect rate's denominator: the desk cannot
connect a call that was hung up, and charging it against them measures the
client's own marketing.

### The join, and its coverage

A call knows the number it dialled and nothing else about a lead, so the number
is the join. `readPhone` in `packages/core` reduces both sides to ten digits,
and is deliberately strict: no prefix matching, no partial matches, and
placeholders like `0000000000` are refused because keyed they would collapse
many leads onto one merchant. A number that cannot be keyed is counted by
reason and shown.

Leads had no phone number at all before this — `Phone` and `MobilePhone` are
now mapped as ordered candidates, and the first that *keys* wins rather than
the first that is populated.

Measured over the 90-day window: **27,382 of 28,862 calls carry a lead
(94.9%)**; 1,333 have a good number belonging to no lead in the CRM, and 147
have no usable number. Coverage is the first figure on the card because every
figure after it is computed over the matched subset.

**An ambiguous number is left unmatched.** Where two leads share a number — a
merchant who filled the form twice, an office switchboard, or one of the test
numbers in this data — nothing says which lead the call belongs to. Assigning
it to the newest would make speed to lead look measured when it is arbitrary.

### Speed to lead, and attempts

From the lead's creation to the **first outbound, non-abandoned** call to its
number. Inbound is excluded — a merchant ringing in is not a response time —
and so is any call stamped before its lead, which happens when the lead is
created during the conversation: real, genuinely instant, and not a response to
anything.

The median, not the mean, because one lead called three weeks late moves a mean
and says nothing about the desk; p90 is shown too, because the tail is what a
client argues about. Quantiles are nearest-rank rather than interpolated: a
median of 214.5 seconds when no call took that long is a figure nobody can go
and check.

Measured: median **11h 35m**, p90 11d 18h, over 2,654 of 3,823 leads created
(69.4%). **15.1%** were called inside five minutes — of the leads that were
called, not of every lead. Attempts per lead: mean 7.6, median 4, over 19,483
attempts; 564 leads were reached on the first attempt and 1,158 were called
more than once and never reached.

### Two stale blocked states, and the bug that kept one alive

Both `call_tracking` and `salesforce` carried reasons that had stopped being
true. Salesforce was `degraded` over `csbs__Decline_Reason__c`, which is now
read at lender grain from the submission object.

Correcting call tracking exposed a seed bug worth recording: the connection
upsert key includes `account_identifier`, so changing `pending` to `aloware`
**inserted a second row** and left the first behind. The data quality card then
faithfully rendered the stale one. `apply.ts` now prunes rows for the same
platform under a different identifier, but only where they hold no credentials
— an unauthenticated row is pure configuration and safe to drop, while one
holding a credential blob may be a genuinely separate account. The identifier
is a label; the credential is the identity.

### PII

The export holds merchants' phone numbers, names and emails, agents' names,
note bodies and recording links. It lives in `data/private/`, which is
gitignored, and **only what is needed is ingested**: the id, timestamp, type,
direction, disposition, two durations, the contact number and id, and the
agent's name. Names, emails, bodies, notes and recordings are not read.

`calls.contact_number` and `calls.agent_name` are the only PII stored, both
tenant-scoped with RLS, FORCE and the usual two policies, plus two mutations
and three isolation tests — a leak here would tell one client whom another is
calling and how often. **Neither is rendered on any screen**: the card shows
counts, shares and durations. The import script prints only aggregates.

### The webhook

`POST /api/webhooks/aloware/{tenant}`, authenticated with
`ALOWARE_WEBHOOK_SECRET` as a bearer token on the cron route's pattern:
constant-time compare, 503 when the secret is unset, 404 rather than 401 when
it does not match. Accepts a single event or a batch.

**Idempotent by construction rather than by bookkeeping** — there is no "have I
seen this?" lookup because the upsert key is the vendor's own id. A duplicate
answers 200 rather than 409, because a webhook sender treats 409 as a failure
and retries it forever. A rejected record — an SMS, or one with no id — also
answers 200 with the reason in the body and a warning in the log: retrying it
forever helps nobody, and a systematic rejection should be visible rather than
a quiet gap.

### Two other bugs this surfaced

**`--since` never reached the sync.** `sync-salesforce` read the flag,
documented it in its usage line, and passed it only to the click-ID backfill —
so `--since 2024-01-01` looked like a full re-pull and quietly ran an ordinary
incremental one off the watermark. Found while trying to backfill lead phone
numbers, which is exactly the situation the flag exists for.

**The export's timestamps have no timezone.** `2026-06-19 11:32:04`, read by
`new Date()`, parses in the server's zone — UTC in a container — putting every
call four or five hours before it happened. Speed to lead is a subtraction
between a CRM timestamp and a call timestamp, so the error would not have
looked like an error. It would have looked like a desk that never picks up the
phone. `parseWallClock` reads it in the tenant's zone, as §16 requires, and is
tested across a daylight-saving boundary.

---

## §10 and §14 — asset storage is S3, and a delivered count is derived from approvals

**Superseded 21 September 2026 — see "§9, §10 and §14 — the workspace and the
delivery view are removed" below. Everything in this section describes software
that no longer exists; it is left as the record of what was built and on what
reasoning, because the removal is a product decision rather than a correction
of it.**

**The brief names Vercel Blob (§14, `BLOB_READ_WRITE_TOKEN`). Storage is AWS S3
instead.** The decision is the client's and was made on 19 September 2026. It
changes nothing about the rule §10 states — blob keys prefixed
`tenant/{tenant_id}/`, no public objects, every URL signed and
authorisation-checked — only where the bytes live. `BLOB_READ_WRITE_TOKEN` is
removed from `.env.example`; the replacement variables and the exact bucket and
IAM settings are in `docs/asset-storage.md`.

Two properties of the IAM policy are worth stating because they are load-bearing
rather than incidental. The application's credentials carry **no
`s3:ListBucket`**, so a leaked key cannot enumerate what other tenants hold —
the application only ever addresses a key it already read off a row through row
level security. And they carry **no `s3:DeleteObject`**, which makes §10's "old
versions are never deleted" a property of the credentials rather than a
convention in the code.

### The delivered count is `resolveDelivered`, and it is not a sum

§9.4 says a delivered figure comes from approved assets "or a recorded count
where there is no artifact". The word that needed a decision is *or*. A
commitment can have both — twelve approved articles and a spreadsheet tally of
twenty — and adding them double-counts the moment somebody uploads work they had
already counted.

**Approved artifacts decide the figure wherever they exist.** A hand-recorded
count is for the commitments that produce no artifact at all — backlinks,
tracked GEO prompts, concurrent A/B tests — and where one exists *alongside*
artifacts it is rendered beside the figure, in the ⓘ and in its own CSV column,
never folded in. Preferring the tally would be measuring data entry, which this
product has already retired one metric for (§8, offer rate).

Three states, not two, and the middle one is the reason this is written down:

| Artifacts tagged to the commitment | Delivered renders as |
| --- | --- |
| None, and no hand-recorded count | `Not recorded` |
| At least one submitted, none approved yet | `0`, with the awaiting-approval count |
| At least one approved | the count of approved, latest-version artifacts |

A zero appears only once an artifact is in front of the client. Before that
there is nothing to count, and `0 of 20` would read as a failure to deliver
rather than as nothing to report. A draft in Zeeraa's own column does not
trigger it either: work in progress is not a claim about delivery.

**A superseded version counts toward nothing.** One article approved at v1 and
approved again at v2 is one article delivered. `assets.supersedes_asset_id`
carries the chain and migration 0013 adds the partial unique index that keeps it
a chain rather than a fork — two rows replacing the same predecessor would count
one piece of work three times.

### Approving is a database control, not a hidden button

§10 says only `client_admin` approves. That was true of `canApproveAssets` in
`packages/core`, which decides what to render — and rendering is not access
control, because the endpoint is reachable without the button.

Migration 0013 adds `app.enforce_asset_review_authority()`, a `BEFORE INSERT OR
UPDATE` trigger on `assets`: a transition into `approved` or
`changes_requested` requires `app.effective_role() = 'client_admin'`, a
transition into `submitted`, `in_review` or `published` requires a Zeeraa role,
and `approved_by_user_id` / `changes_requested_by_user_id` must name the user in
context rather than whoever the request claimed. SECURITY DEFINER with a pinned
`search_path`, reading membership through `app.membership_index` like every
other policy helper, so it needs no elevation and sets no session flag.

A Zeeraa admin holds every other power in this product and deliberately not this
one. **A delivered figure Zeeraa could raise on its own behalf is not a
compliance record**, and the delivery view is a compliance record.

The check is skipped where no user is in context. That is the seam between the
two ways this database is written to, not a hole: every application write goes
through `withTenant`, which always sets a user, and a write with no user is a
seed or a maintenance repair running as a role the application is not a member
of. Four mutations in `scripts/mutation-test.ts` cover the trigger, the version
chain and the `deliverable_records` upsert key; 26 of 26 mutations are killed.

### §12 — "Items delivered" was a category error and is now "Artifacts approved"

The delivery view carried a KPI that summed every commitment's delivered figure.
While every commitment read `Not recorded` it showed nothing and the problem was
invisible; with real counts behind it, it added 2 pieces to 1 page to 34 links
and reported 37. That is the same category error §9.2's totals row is forbidden
to make, and the figure's movement would have been dominated by whichever
commitment happens to be counted in the largest unit.

It is now **Artifacts approved** — approved, latest-version artifacts in the
period, which is one unit and genuinely summable. The hand-recorded counts keep
their place in the table and in `Commitments met this period`; they are no
longer added to anything.

### Out of scope, deliberately

@mentions, the mention picker, the activity rail, asset comments and
notifications are collaboration rather than delivery tracking, and none of them
is built. The **audit trail** is written regardless: `activity_log` takes a row
for every upload, submission, approval and rejection, because "we never signed
off on that" is settled by rows and not by a feed, and the table is append-only
at the database level.

---

## §9, §10 and §14 — the workspace and the delivery view are removed

**21 September 2026.** §9.4 (the delivery view), §10 (the content and approval
workspace) and the §14 storage variables that served it are removed from the
product. The screens, the API routes, the S3 upload path and nine tables are
gone; migration `0016_remove_workspace_and_delivery.sql` drops them.

**The reason is not that they did not work.** The review loop shipped on
19 September 2026 and did what the section above describes. It is that
**Zeeraa's delivery flow happens in Slack and Drive**, and nothing was going to
move it. A workspace nobody uploads to does not sit neutrally in the product:
the board reads `Empty` in all five columns and eleven commitments read
`Not recorded`, which is the shape of a client being failed rather than of a
feature going unused. An empty workspace is worse than no workspace.

That is also why this is a removal rather than a hidden feature flag. A screen
behind a flag is still a screen somebody has to keep correct, and the tables
behind it still have to carry policies, grants, FORCE and a maintenance path
for as long as they exist.

### What went

| | |
| --- | --- |
| Screens | `/{tenant}/delivery`, `/{tenant}/workspace` |
| Routes | `/api/assets/…` (3), the `delivery` table of the CSV export |
| Storage | `lib/storage.ts`, the S3 presign path, both `@aws-sdk` dependencies, `S3_*` |
| Core | `packages/core/src/delivery.ts` and its tests; `canApproveAssets`, `canUploadAssets`, `canComment`, `canSeeInternalDeliveryColumns` |
| Tables | `assets`, `asset_types`, `asset_comments`, `deliverable_commitments`, `deliverable_records`, `sla_commitments`, `sla_events`, `mentions`, `activity_log` |
| Database controls | `app.enforce_asset_review_authority()` and its trigger; five enum types |
| Config | the `sla_compliance` and `delivery_completion` rows in `tenant_metrics` |

`docs/asset-storage.md` goes with the bucket it documented. The IAM reasoning
in it — no `s3:ListBucket`, no `s3:DeleteObject` — is worth recovering from git
history if this product ever stores a client's files again.

### The audit trail goes too, and that is the one worth arguing about

The section above states that the audit trail is written regardless of whether
collaboration is built, because "we never signed off on that" is settled by
rows and not by a feed. That reasoning was sound while there were approvals to
audit. There are none now: `lib/assets.ts` was `activity_log`'s only writer and
nothing ever read it, so keeping the table would preserve not a record but an
empty table with two restrictive policies and a mutation guarding it.

It is dropped rather than left in place, on the client's decision of
21 September 2026. If the product ever records an act somebody could later
dispute, the table comes back with that feature — `0000_initial_schema.sql` has
its shape and `0001_rls_policies.sql` has the append-only policies.

### The mentions feature, which never existed

`memberships.slack_user_id` is dropped with it. It was per membership rather
than per user because Zeeraa staff sit in several client Slack workspaces with
a different member ID in each — a decision worth keeping the reasoning for, and
the only thing that was ever built of @mentions.

`memberships.slack_enabled` and `notifications.delivered_slack_at` stay. Those
belong to notification delivery, which is a separate feature.

### What stays, and is now dormant

`notifications` keeps its table, its policies and its grants. Nothing writes to
it and nothing reads it any more — **the bell in the top bar is removed**,
because its only destination was the workspace and its count was always zero.
It is a table waiting for a feature rather than the remains of one, which is
the opposite of the case for `activity_log`.

The **reconciliation item for the backlink commitment** stays as well. It
records that the proposal states 30–40 per month in one place and 30–50 in the
first thirty days in another. That contradiction is a fact about the proposal
and is still unresolved; it does not depend on the platform tracking delivery.

### Deploy order

**The migration runs after the deploy, not before.** For an addition the schema
leads — the code that needs a column cannot ship before the column exists. For
a removal it follows: between the two, the old code is still serving and would
be querying tables that had already been dropped. Applied to Neon on
21 September 2026, after the Vercel deploy went live.

One thing in that migration is worth reading before copying it. The `DELETE`
against `tenant_metrics` is bracketed by `NO FORCE` / `FORCE ROW LEVEL
SECURITY`, because `tenant_metrics` carries FORCE and its policies name
`zeeraa_app`, `zeeraa_jobs` and `zeeraa_maintenance` — not the owner role
migrations run as. Without the bracket the owner is default-denied, the
statement matches zero rows, reports `DELETE 0`, and the migration succeeds
having changed nothing. It did exactly that when first written. `ALTER TABLE`
holds ACCESS EXCLUSIVE, so no session sees the table unforced, and a failure
anywhere in the migration rolls back with FORCE still on.

---

## §11 and §14 — sign-in is a password, and accounts are created by an admin

**21 September 2026.** §11 specifies a magic link over Resend, with Google as a
second provider, and §14 names `RESEND_API_KEY`, `EMAIL_FROM`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the Auth.js secrets. All of it is
removed. Sign-in is an email address and a password; an admin creates the
account, sets the first password and passes it on out of band.

**No email leaves this product now.** That is the requirement, not a consequence
of it: the client does not want a mailbox in the trust path, and a magic link
makes whoever controls the inbox the account holder.

### What replaced it

| | |
| --- | --- |
| Credential | argon2id, 19 MiB / t=2 / p=1, PHC format, in `users.password_hash` |
| Session | a row in `sessions`, named by a 256-bit opaque cookie |
| First login | `users.must_change_password`, enforced in `requireTenant` |
| Reset | an admin issues a new password and every session of that user is closed |
| Recovery | none — there is no mailbox to recover through |

`next-auth` and `@auth/drizzle-adapter` are gone with the providers. With only
a password left they were carrying a cookie and a session lookup, and **Auth.js
does not support the Credentials provider with database sessions at all** — it
requires a JWT strategy. Keeping the library would have meant either giving up
database sessions or minting the session row ourselves anyway. The route that
used to be `api/dev-signin` already did exactly that, so the mechanism was
proven before it was adopted.

### Why not a JWT

§12's rule that revoked access takes effect on the next request is the reason
sessions were rows in the first place, and it survives unchanged. A JWT cannot
be withdrawn — it is valid until it expires — and the whole shape of this
product now depends on withdrawal working: initial passwords are read out over
chat, and an admin reset exists precisely because one may have reached the
wrong person. A reset that left the old sessions alive would not be a reset.

### Creating an account is not granting access

Two statements, two policies, on purpose. `users_admin_create` checks the
*actor* — a new row has no membership yet and so nothing tenant-scoped to test —
and `memberships_admin_write` carries the tenant half. An account with no
membership can sign in and reaches `/no-access`, exactly as an unrecognised
magic-link address did.

One consequence worth knowing, because it caught this implementation once: the
`users` SELECT policy admits only people who share the current tenant, so a
just-created account is **invisible to the admin who created it** until the
membership row exists. `INSERT … RETURNING` returns nothing, and so does a
read-back. `createUser` therefore generates the id itself and detects a
duplicate address from the `23505` unique violation rather than by looking to
see whether the row landed — the first version read back, found nothing on the
happy path, and reported every successful creation as "an account already
exists".

### Client admins can now grant access, within limits

§11 left account administration entirely with Zeeraa. The client asked for
client admins to manage their own people, so `memberships_admin_write` is
widened — and the widening is one clause:

```sql
OR (app.effective_role() = 'client_admin' AND role IN ('client_admin','client_viewer'))
```

**`zeeraa_member` and `zeeraa_admin` are the roles `canSwitchTenant` lets out of
the tenant.** A client admin able to grant one could mint an account that reads
every other client in the system, so this is privilege escalation rather than a
matter of taste. Two mutations cover it.

### A self-promotion hole, closed on the way past

`memberships_update_own` exists so somebody can change their own notification
preferences, and its comment said so. What it allowed was an UPDATE of any
column of your own row — including `role` — and `app.effective_role()` reads
`app.membership_index`, which is maintained from that table. `UPDATE memberships
SET role='zeeraa_admin' WHERE user_id = me` would have taken effect at once.

It was not reachable: nothing in the application wrote to `memberships` at all.
It is closed now because this work makes the table writable from the application
for the first time, and a latent hole beside a new write path is not one to
leave. Row level security cannot restrict columns, so the column grant does:

```sql
REVOKE UPDATE ON public.memberships FROM zeeraa_app;
GRANT UPDATE (email_preference, slack_enabled) ON public.memberships TO zeeraa_app;
```

### Removing access used to strand the account

Reported 21 September 2026, and it is the sharpest edge this design had.

Remove somebody's membership and they became **unreachable from the
application**. "Create an account" refused, because `users_email_key` is global
and the address was taken. "Add an existing account" refused too, because its
lookup runs under `users_visible_within_tenant`, which admits a row only when it
is the caller's own or the target shares the current tenant — and a user with no
membership anywhere shares nothing with anybody. The two forms contradicted each
other, and neither could finish the job.

Migration `0019` adds a second permissive SELECT policy on `users`: an admin may
see an account that belongs to **no tenant at all**. The roster policy is
unchanged; this sits beside it.

```sql
CREATE POLICY users_admin_resolve_unattached ON public.users
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (
    app.effective_role() IN ('zeeraa_admin', 'client_admin')
    AND NOT app.holds_any_membership(users.id)
  );
```

**`app.holds_any_membership` has to be SECURITY DEFINER over
`app.membership_index`**, and that is the whole safety of it. As an
invoker-rights function reading `public.memberships` it would see only the
caller's own rows and the current tenant's, so a user attached solely to
*another* engagement would read as unattached — and the policy would publish
another client's roster. A mutation covers exactly that rewrite.

**What this exposes, and why it is not new.** An admin can now discover that an
address exists while belonging to nothing. `users_email_key` is global, so
"Create an account" has always answered that question by refusing with a unique
violation. What changed is that the answer leads somewhere.

**What it deliberately does not do** is make an account that belongs to a
different engagement visible — to a Zeeraa admin as much as to a client admin,
because it is another client's roster. Moving one between engagements is
`scripts/grant-membership.ts` on the maintenance connection, the same gate as
`set-password.ts`. The screen says so rather than implying the form can do it.

The messages are now a chain rather than a contradiction: create refuses with
"use Add an existing account", that form succeeds for an unattached account, and
where it cannot it names the reason and who can act.

### One mutation that could not be made to bite

`users_admin_manage` scopes a password reset to somebody in the current tenant.
Removing that clause survives the whole suite — and that is a fact about the
schema, not a gap in the tests. `users_visible_within_tenant` already refuses to
surface a user from another tenant, so the row cannot be found to update and the
statement reports `UPDATE 0`. Checked against a mutated schema rather than
assumed. The clause stays, because a policy should read correctly on its own and
because a future change to the SELECT policy must not silently widen what a
reset can reach; the mutation now drops the policy outright, which a test does
catch, and `users-visible-to-all` covers the lock that is actually load-bearing.

### Deploy order: expand, deploy, contract

Two migrations, not one, and the split is not ceremony.

`0017` **adds only** and runs *before* the deploy — for an addition the schema
leads, because the code that reads `password_hash` cannot ship before the column
exists. Every new column is nullable or defaulted and every policy is new, so
the deploy still serving does not notice it.

`0018` drops `accounts`, `verification_tokens` and `users.email_verified`, and
is meant to run *after*. **It did not, on 21 September 2026**: `pnpm db:migrate`
applies every pending migration and drizzle's migrator has no "up to N", so both
halves went out together and the contract landed before the deploy. See
`docs/state.md`, "The deploy order went wrong on 0018". A split whose halves
still run together is a comment rather than a control; staging them means not
having the later file in the tree when the earlier one runs. They cannot go in `0017`: the old deploy hydrates a session
through the Drizzle adapter, and that selects `users.email_verified` on **every
authenticated request**. Dropping it while the old code served would have taken
down every signed-in page, not merely the sign-in form. Production held four
live sessions when this ran, so that was a real window rather than a theoretical
one.

### The lockout this would have shipped without a bootstrap path

**Every pre-existing account has a null `password_hash` and cannot sign in.**
That is deliberate — the accounts authenticated by email and hold no password,
and there is no default and no grace period.

What is not acceptable is the consequence: passwords are set on the People
screen, the People screen requires being signed in, and after this deploy nobody
can sign in. The first deploy would have locked everybody out of the application
whose only way back in is to already be inside it.

`packages/db/scripts/set-password.ts` is the way back in:

```bash
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db set-password someone@example.com
```

It generates the password rather than taking it as an argument, so it never
reaches a shell history; prints it once; sets `must_change_password`; and closes
every session the account holds. It is not a web route and not seedable — the
gate is holding the maintenance connection string, which the application does
not have, and which `withMaintenance` requires a role membership to use. The
same gate that protects every other cross-tenant operation here.

---

## §12 — improvement direction belongs to the metric, not to the card

**21 September 2026.** §12 says green and red mean improvement and regression as
each metric's `improvement_direction` defines them. That was implemented as a
column on `tenant_metrics` which each card looked up by key. The colouring was
right — every configured row on production was correct, and cost per funded deal
and CPA both read `down` — but nothing made it so.

Three things were wrong with it as a design, none of which had bitten yet:

1. **A direction is not client configuration.** There is no client for whom a
   rising cost per deal is an achievement. Putting it in a config row invites a
   per-tenant answer to a question that has one answer.
2. **A missing row rendered neutral and a wrong row rendered wrong.** `cpc`,
   `cpm` and `cost_per_conversion` have no rows at all — they are computed in
   core and shown on the platform pages — so a delta added to any of them would
   have come out grey, and a row seeded `up` by mistake would have painted a
   rising cost green with nothing to catch it.
3. **Every card named its own metric key**, so the direction was one typo away
   from being the wrong metric's.

Direction is now declared in `packages/core/src/metric-direction.ts`, **keyed on
`formula_key` rather than on the tenant's metric key**: the formula is what
fixes the direction, and two tenants may call `cost_per_stage` different things.
`tenant_metrics.improvement_direction` survives as the fallback for a formula
core has never heard of — a tenant may define a metric this codebase has not
seen — and is overridden wherever they disagree.

**Nothing defaults to `up`.** An undeclared formula resolves neutral, and an
undeclared formula whose *name* is a cost resolves `down`:

```ts
const COST_SHAPED = /(^|_)(cost|cpa|cpc|cpm|cpl|cac|spend_per)(_|$)/;
```

So `cost_per_mql`, added next month and declared nowhere, is lower-is-better
without anybody remembering. The one answer that paints a rising cost green is
the one this cannot produce.

`paid_media_spend` is declared **explicitly neutral** rather than left out, so
it reads as the decision §12 describes — spending less is not an achievement and
spending more is not a failure — rather than as a gap, and so a stray config row
cannot colour it.

### What was checked, and what it found

Every place a cost metric reaches a screen: the executive hero, the KPI row, the
monthly performance page, the month-over-month bar chart, the platform pages and
the monthly table. **No live miscolouring.** The platform pages render CPC, CPM
and cost per conversion as figures with no delta and no colour, so there was
nothing there to get wrong; those formulas are declared now so that a delta
added later is right on the day it is added.

Rates stay higher-is-better, with two deliberate exceptions that are the reason
this is a table and not a rule about the word "rate": `duplicate_rate` and
`resubmission_rate`. A duplicate is waste and a resubmission is rework.

### Enforcement, rather than a convention

- `metric-direction.test.ts` in core asserts the direction of every cost metric
  and every rate, and that no undeclared formula — invented names included —
  can resolve `up`.
- `delta-tone.test.ts` in the web app asserts the join nothing else covers:
  definition → assessment → the colour class on screen. `toneFor` moved into its
  own module to be testable, since that app's vitest has no JSX transform.
- `metric-direction-seed.test.ts` fails if a seeded row disagrees with the
  formula it names, so configuration cannot drift from the definition unnoticed.
- `metric-direction-usage.test.ts` reads the TSX sources and fails if any screen
  states a direction as a literal instead of taking it from the metric. A
  source-level test is unusual and earns its place here: the thing being
  prevented is a plausible one-line edit that produces a plausible-looking
  screen, and no type or runtime check can see it.

---

## §12 — the executive hero tracks the engagement ramp

**21 September 2026.** The hero's cost-per-funded-deal panels showed a figure, a
delta and a bare series. They now show the figure against **what the engagement
contracted it to be**, for Google Ads.

Zeeraa signs against a curve rather than a number: an eight-month decline in
cost per funded deal, starting at $4,000 on a $30,000 budget and reaching $2,705
by M8, with a budget, CPA, approvals and funded-deal target beside each month.
The stated figures are the rounding of 4000 × 0.92 × 0.95^(n−2) from M2, and are
stored as the stated figures rather than as the formula — the contract states
numbers, and a formula would be this codebase's reconstruction of them.

### The start month is configuration, and today it is unset

**M1 is whenever the contract begins.** That is decided when the engagement is
signed and is not knowable from the data, so it is `engagement_start_month` in
`tenant_config` and it is null.

Null is rendered, not worked around. The Google Ads panel shows actual cost per
funded deal with no target line and one sentence — *"Ramp targets begin when the
engagement starts."* Assuming a start would be the worst available option: the
obvious guess is the month ingestion began, June 2026, which would place M1 four
months back and report the client as far behind a schedule nobody has started.

Set the month and the whole curve takes its position: M1 lands on it, every
later month follows, and the target draws alongside actual. Verified by setting
it locally and watching the curve and the gap appear.

### Google Ads only

`engagement_targets` is keyed by platform, and only Google Ads has rows. Meta's
panel renders exactly as before — no curve, no gap, no line. A target drawn on a
channel nobody contracted for is a number with no source, which §16 forbids
outright, and inheriting Google's curve would be precisely that.

### The gap is a number, and it is month against month

A chart shows one line above another; it does not say by how much, and "by how
much" is what the engagement is judged on. So the distance is written out:

> Aug · **$5,087 above the M3 target** of $3,496

**The month matters and is stated.** The figure above it covers the selected
window — ninety days by default — while the ramp contracts a *monthly* number.
Subtracting one from the other would be a category error dressed as a variance,
so the gap is computed from the last completed, non-provisional month that has
both a target and a measurement, and the line names that month. Where no month
qualifies yet, it says so rather than comparing mismatched grains.

### Colour follows the metric, as everywhere else

The measured line is drawn green where cost fell and red where it rose, from
`seriesTrend` — first measured point against last, so a month of noise in the
middle is not a trend — assessed by the same `improvement_direction` that
colours every delta. The gap's colour comes from `gapToTarget`, which runs
through `delta` rather than through `actual < target`, so "better" has one
definition in this product and not two.

The contracted curve itself is dashed and drawn in the muted mark colour,
beneath the measured line: it is a commitment, not something anybody observed.
Both series are scaled together, so the gap between them is the distance on
screen rather than an artefact of scaling to one of them.

### What is not here

The budget, CPA, approvals and funded-deal targets are part of the model and
`engagement_targets` has a nullable column for each. Only M1's budget has been
supplied; the rest await the model file and are **null rather than invented**.
Nothing renders them yet.

---

## §12 — one date range picker, replacing the window pills

**21 September 2026.** Every screen carried a 30/90/365 segmented pill. It could
express three periods, all of them trailing today, so "how did August go" had no
answer and "since the engagement started" had none either. It is now two date
fields with the common ranges beside them.

- `?from=&to=` in the URL, so a range is bookmarkable, survives a reload, opens
  in a new tab, and is what the CSV export reads — every property the pill had.
- **Presets**: Today, 7d, 30d, 90d, MTD, All time. "All time" starts at the
  first day anything was ingested; with nothing ingested it falls back to 90
  days rather than starting at the epoch and drawing sixty years of nothing.
- **The resolved period is stated in words** beneath the control —
  `Jun 24 – Sep 21, 2026 · 90 days`. A pill saying "90d" does not say which 90
  days, and the period is the first thing questioned in a meeting.

Resolution lives in `packages/core/src/date-range.ts` because five screens read
the same params and must not disagree about what they mean.

### A plain GET form

No client state and no server action: submitting navigates to `?from=&to=`,
which is the same shape the presets link to. It works with JavaScript off, like
every other form here. The page's other filters travel as hidden inputs — a GET
form replaces the whole query string, so without them choosing a date would
silently drop the attribution model or the selected channel.

### What it refuses, and what it does not decide

A reversed pair is **not** swapped. Two dates the wrong way round is as likely
to be the wrong field filled in as a transposition, so it falls back to 90 days
and says why in one line. Half a pair, an impossible date (`2026-02-31` — which
`new Date` would roll into March) and a span over three years are refused the
same way. The range always resolves to *something*, because a page with no range
is a blank page.

`?days=` is still read. A bookmark or a saved export URL made before this
existed keeps meaning what it meant rather than silently resolving to something
else.

### The hero lost its own toggle

§12's executive hero had a 3m/6m/12m control of its own, because the north star
is a ratio with one or two funded deals a month and a weekly bucketing of it is
mostly gaps. That reasoning was sound and the control still had to go: two date
controls on one page is two answers to "what period am I looking at".

The hero series now follows the page range, bucketed monthly at ten weeks and
above and weekly below. A short range therefore draws a short series — a
seven-day range is a couple of points — which is the honest consequence, and
`MiniChart` already draws a single point as a point rather than as a line.

### Before ingestion, unchanged

A range reaching back before anything was ingested keeps the existing treatment:
the figure renders "not ingested before 2026-06-20" rather than a zero. Verified
by asking for January to September and checking that no zero appears where a
month has no measurement — a bar at the axis is a measurement, and nobody looked.

---

## §7 and §8 — Meta Ads, at campaign grain, with channel-only attribution

Built 19 September 2026. Meta was scheduled last in the connector order because
its submit-then-poll Insights jobs looked like the hardest piece. They are not
needed: that path exists for ad grain over long windows, and this engagement
reads **campaign grain**, where ninety days of Spartan's account is 102 rows in
one synchronous call. The registry order is updated to match what was actually
required rather than what was assumed.

### Meta attribution is channel-level, permanently

This is the finding that shapes everything else, and it is not a gap to be
closed later.

Google serves `click_view`, which resolves a `gclid` to the campaign that
produced it. **Meta publishes no equivalent for `fbclid` — there is no endpoint,
at any grain, that maps a click identifier back to a campaign.** So an `fbclid`
on a lead proves the channel and can never prove the campaign.

The consequences, all of them deliberate:

- `metaConnector` has **no `fetchClicks`**. Implementing one that returned an
  empty array would have been worse than omitting it: the click ledger would
  record ninety days of successful ingestion that fetched nothing.
- `ad_clicks` never holds a Meta row, and the Meta sync has two passes where
  Google's has three.
- Every Meta-attributed deal reports as *click without campaign*. That is a
  state the model already had — Google clicks that aged out of the 90-day
  window — so nothing downstream needed a new concept.
- Meta's per-campaign cost-per-deal breakdown is empty by construction, not by
  coverage. `dealsResolvingToCampaign` is 0 for Meta and always will be.

### The Salesforce side needed no admin work, and was never the blocker

Checked against the live org rather than the setup document, which recommended
creating `FBCLID__c`. That recommendation is moot: the client already had
**`acq_fbclid__c`**, Text(255), on **both** Lead and Opportunity, readable by
the integration user, and **already carried by the Lead → Opportunity
conversion mapping** — one of six click-ID fields mapped there.

| | |
| --- | ---: |
| Leads carrying `acq_fbclid__c` | 972 |
| Leads carrying `gclid__c` | 2,457 |
| Leads carrying both | 15 |
| Converted leads with fbclid, no gclid, that became an opportunity | 58 |
| Opportunities carrying `acq_fbclid__c` at the time of the audit | 0 |

The zero is expected rather than broken: Salesforce lead field mapping copies at
the moment of conversion and never retrospectively, so the Opportunity route
only pays from conversions after the mapping was created. Everything available
today comes from `backfillClickIdsFromConvertedLeads`, which walks the fields in
`fieldMapping.lead.clickIds` — and that named `gclid__c` alone.

**So the field was present, mapped and populated, and the platform read none of
it.** The reason was recorded and was correct at the time: a Meta channel row
would have shown deals against no spend, which is exactly the shape §9.2's
separation rule forbids. Ingesting Meta spend is what removed the objection,
which is why `meta: 'acq_fbclid__c'` joins the Lead mapping in the same change
as the connector. **Neither half is correct alone** — the mapping without the
spend breaks the separation rule, and the spend without the mapping reports a
channel that never attracts a deal.

Running the backfill recovered 58 Meta click IDs, exactly matching the audit,
and moved one funded deal out of the unattributed bucket and into Meta's.

### Two figures that would have meant different things in the same column

Both are configuration on the connection, both default to the honest reading,
and both were measured before being chosen.

**Clicks.** Meta's `clicks` counts every click on an ad — reactions, comments,
profile taps. Google Ads' `clicks` counts clicks that go somewhere. Over the
same trailing 90 days the two are **8,074 and 5,135**, a 36% gap. The
performance table puts both channels' clicks in one column under one heading and
sums them in a totals row, so `clickMetric` defaults to `inline_link_clicks`.
Summing Google's clicks with Meta's `clicks` would have been the same category
error as adding pages to backlinks, only less visible.

**Conversions.** Meta's `actions` array **contains rollups beside their own
components**, and nothing in the payload marks which nest. Over the same window
`lead` is 1,756, which is exactly `onsite_web_lead` (921) plus
`onsite_conversion.lead_grouped` (835); `page_engagement` similarly subsumes
`post_engagement`. Summing the plausible-looking set reports roughly double the
truth and looks entirely reasonable. `conversionActionTypes` defaults to
`['lead']` alone, and the test that proves the double-count is kept as
arithmetic rather than as an assertion about an error.

### What the account reports

`Spartan Capital (2025)`, USD, `America/New_York` — the same zone as the tenant
and the Google Ads account, so no daily figure carries a boundary error. The
connector still checks, and reports `degraded` rather than `healthy` on a
mismatch of either zone or currency: the data arrives and is usable, and a spend
column mixing two currencies is a wrong number rather than a missing one.

An ad account that is disabled, unsettled or in a payment grace period reports
`waiting_on_client`, as does a revoked system user token — a token stops working
because of a change in the client's Business Manager, and no retry or code
change fixes it.

### Trailing 90 days, both channels, kept apart

| | Google Ads | Meta Ads |
| --- | ---: | ---: |
| Spend | USD 79,175.75 | USD 17,857.33 |
| Impressions | 60,864 | 170,471 |
| Clicks | 3,588 | 5,137 (link clicks) |
| Funded deals attributed | 9 | 1 |
| — of those, campaign known | 6 | **0, permanently** |
| Cost per funded deal | USD 8,797.31 | USD 17,857.33 |
| Plausible range | 3,958.79 – 8,797.31 | 1,488.11 – 17,857.33 |

Eleven funded deals remain attributed to nobody and are in neither denominator.
Blended cost per funded deal is still not computed: it is a different metric
with a different denominator, and two channels out of six is not every channel.

**`spend-to-funded` now discovers its channels instead of naming one.** It
previously hardcoded `google_ads`, which would have silently omitted Meta from
the only script that reports the metric the engagement turns on.

---

## §12 — the executive hero is one panel per channel, and there is still no blended figure

Changed 19 September 2026, when Meta made the old behaviour a distortion rather
than a simplification.

The hero used to render **one** channel's cost per funded deal, chosen as
whichever spent most, with an ⓘ explaining that a blended figure was not
computable. With one connected channel that was honest. With two it put Google
Ads' USD 8,797 above the fold under a heading the client reads as *what a deal
costs us*, while Meta's USD 17,857 — **twice the price, on a fifth of the
spend** — sat two screens down in a table. The label was accurate and the screen
was misleading, which is the failure mode this product exists to avoid.

There is now **no lead channel**. The hero renders one panel per connected
channel, side by side, each carrying its own figure, its own coverage line, its
own range and its own series. Channels are ordered by spend, which is
presentation and carries no arithmetic, because no figure on the card combines
two channels.

**And still no blended figure.** The arithmetic is available and it would be
wrong: blended cost per funded deal is total marketing spend over total
marketing-sourced deals, a different denominator from any channel's, and two of
six channels summed under a blended label is right arithmetic with the wrong
noun.

Three details that follow from the rule rather than from taste:

- **The range is per panel, not per card.** Meta's range is USD 1,488–17,857
  because one deal carries its whole spend; Google's is 3,959–8,797 because nine
  do. Averaging them would hide precisely the difference worth seeing.
- **The method drawer carries one coverage note per channel.** A single note
  across two channels would have to average two coverages to say anything.
- **The target is stated once and drawn on neither chart.** The engagement
  states one number and configuration carries no per-channel target, so a line
  across both panels would assert that each channel is independently held to it
  — a claim nobody has made. It renders as a figure in the card header with the
  reason in its ⓘ.

The four-month secondary strip is gone. It was one channel's, and showing it for
each channel inside a half-width panel would have crowded the figure the card
exists for. The same series is on the monthly performance screen, per channel,
with more room.

---

## §12 — a page per connected platform, and the line between a platform and the CRM

Added 19 September 2026. One page per connected ad platform, in a **Platforms**
section of the rail whose items are the channels this client has actually
connected — data, not a constant. A platform with no connector, or one whose
connection is not healthy, has no rail entry and its URL is a 404: a rail entry
is a promise that a page has something to show.

### The line, and why it is a full-width rule

Everything above **"What became of it · from Salesforce"** is the platform's own
reporting. Google counts a conversion the way this account's tags are
configured; Meta counts a lead the way this pixel fires; neither has any idea
whether a deal was funded. Below the rule is Salesforce, and it says so on the
heading, on the card subtitle and on a badge.

They are separated by a full-width rule rather than sitting in one grid because
adjacency is an invitation to divide. Meta reports 1,761 conversions over this
window and Salesforce attributes it **one** funded deal; a reader who takes
those as two measurements of the same thing concludes the funnel converts at
0.06%, which is not a fact about anything.

### Nothing is computed for a platform that does not report it

The whole page follows one rule: **a figure a platform does not report is
absent, not zero and not borrowed.**

- **Reach and frequency** are Meta's. Google publishes no reach, so those
  figures do not exist on the Google page — they are not rendered as zero, and
  the Google page does not carry an empty row where Meta has one.
- **The link-click distinction** is Meta's. Meta counts every click on an ad —
  reactions, comments, profile taps — as well as clicks that go somewhere;
  Google reports one figure. So `All clicks` and the share that went somewhere
  appear on Meta only, and `clicks_all` is null on Google, which is an absence
  of the distinction rather than every click being a link click.
- **Campaign classification is each platform's own word.** Google's
  `advertising_channel_type` and Meta's `objective` both land in
  `campaigns.campaign_type`, verbatim, and are never grouped across platforms:
  the Google page heads the column "Campaign type" and reads `SEARCH`, the Meta
  page heads it "Objective" and reads `OUTCOME_LEADS`. They answer different
  questions. A value with no label renders as the platform's own string rather
  than being bucketed into "Other", which would hide a campaign kind nobody had
  noticed appearing.

### Reach is stored and deliberately never totalled

Reach counts *people*, and Meta deduplicates them across whatever range it is
asked for. Summing daily reach counts somebody who saw an ad on Monday and again
on Tuesday twice, so the total is always wrong and always too high.

The page therefore renders reach as an amber **`Not summable`** where a total
would go, with the reason in its ⓘ, and shows the real daily figures in the
series — where the grain matches what Meta reported. A deduplicated figure for
the whole window is a separate query against Meta and is not derivable from
these rows; if it is ever wanted, it needs its own storage keyed by period, not
a `sum()`.

### A rate with an empty denominator is an absence

CTR, CPC, CPM, conversion rate and cost per conversion are arithmetic over two
reported figures, and all of them live in `@zeeraa/core` as named functions with
tests. Every one returns `null` rather than 0 or `Infinity` when its denominator
is empty. A day with spend and no impressions did not achieve a CPM of zero;
there was no auction to price. A campaign with clicks and no conversions *does*
have a conversion rate of zero, because that denominator is real — the
difference between an empty denominator and an empty numerator is the whole of
that module.

### A campaign type that did not run is a row of zeroes, not a missing row

Grouping the metrics alone drops a type with no delivery, and a reader cannot
tell a missing row from a type the account does not use — which are the two
answers they are actually choosing between. The breakdown is therefore the
account's configured types left-joined onto delivery, showing "6 of 15" style
counts. Spartan's Google account holds 35 Search, 7 Performance Max and 1
Display campaign and only Search delivered in the window; all three appear.

**There is no Video row, because the account runs no Video campaigns.** Drawing
one at zero to satisfy a list of expected types would be inventing a figure the
platform never reported.

### The share each page covers, and why the pages do not sum

Each outcomes block states its channel's share of every deal in the period —
Google Ads 9 of 21, Meta 1 of 21. **They do not add to 21 and are not meant to.**
Eleven of those deals carry no click from any connected channel and belong to
none of them; that remainder is the honest gap, and the ⓘ on the figure says so
rather than leaving a reader to find the arithmetic doesn't close.

### Meta's campaign attribution is stated, not rendered empty

Meta publishes no lookup from an `fbclid` to a campaign, so the per-campaign
outcome table on the Meta page would always be empty. An empty table reads as
"no deals yet" — wrong, and it quietly implies that waiting fixes it. The card
carries a `Not measurable` badge and the reason instead. The Google page shows
the real table: 6 of its 9 attributed deals resolve to a campaign.

---

## §7 and §9 — GA4 and Search Console, channel-level and never in the funnel

Built 19 September 2026. Both read the **Google Ads credential** — one OAuth
client, one refresh token, one person's consent, three APIs — which is also the
thing that bites: a refresh token carries the scopes it was granted and never
gains more. The token in production held `adwords` alone, so both APIs answered
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` until consent was re-run with
`analytics.readonly` and `webmasters.readonly`. That error is indistinguishable
at a glance from a disabled API or a property the user cannot see, so the client
detects it by `reason` and says which of the three it is.

`google-ads-token` now requests all three scopes and **warns when the consent
screen withholds one** — Google returns a perfectly valid token for the subset,
and nothing fails until the first call to the API whose box was unticked.

### Neither can be attributed to a deal, and that is structural

**The GA4 Data API exposes no identifier for a person or a session.** There is
no `clientId` dimension and no `sessionId` dimension; session identity lives in
the BigQuery export or in a custom dimension the site registers itself. So a
session can never be joined to the lead it became.

The org was checked for a join before anything was built. All 469 Lead fields
were searched for a candidate: `Session_ID__c` exists and is well populated —
2,090 of 2,901 web-originated leads in ninety days, 72% — and its values are
**UUIDs**. GA4's `ga_session_id` is a Unix timestamp in digits and its client id
is `digits.digits`, so `Session_ID__c` is the form vendor's own handle and not a
GA4 key. `probe-ga-join` reports exactly this, by shape, so the next org can be
answered in one command.

Search Console needs no such investigation: it reports what a query did and what
a page did, and never who.

So **neither source enters the attribution join**, neither writes to
`attribution` or `opportunity_click_ids`, and no figure from either is ever
divided into a funded deal. Their pages end with a `Not measurable` card that
says why, rather than with an outcomes section — the same treatment Meta's
per-campaign table gets, for the same reason: an empty section reads as "no data
yet" and implies that waiting fixes it.

### Two tables, not one

`ga4_metrics` and `search_console_metrics`, because the two vocabularies barely
overlap: Search Console has impressions and a ranking position and no notion of
a session; GA4 has sessions and engagement and no notion of a query. Nullable
columns are right where a platform is missing *one* figure its neighbour reports
(`daily_metrics.reach`); they are the wrong answer when a shared table would be
half nulls down the middle.

One row per day per dimension value, which is what makes any window
re-computable. `dimension = 'total'` carries the day's authoritative figure.

### Three aggregations that would have been quietly wrong

- **CTR is never stored.** It is clicks over impressions and is derived at read
  time. A stored ratio is one `sum()` away from nonsense — the aggregate of
  twelve daily CTRs is not the window's CTR.
- **Position is impression-weighted.** Search Console weights its own average by
  impressions; a plain mean weights a day with three impressions like a day with
  three thousand and disagrees with the Search Console UI, which is the report a
  client checks this against. `weightedPosition()` is unit-tested against
  exactly that error.
- **Grouped and ungrouped totals disagree, in both directions, and neither is a
  bug.** Over Spartan's window, grouping by query accounts for **57%** of clicks
  — Search Console omits searches issued by very few people, for privacy — while
  grouping by page accounts for **102%**, because a click is attributed per
  canonical URL. GA4 lands at 100.4% for the same kind of reason. The field is
  therefore called `ratioToTotal` rather than `coverage`: a "coverage" of 102%
  reads as an error, and this is the API behaving as documented. Each table
  states its own figure with its own explanation, and a ratio above 1 renders in
  amber rather than being clamped away.

### The window ends short of today, on purpose

Search Console finalises over two to three days. Asking for days it has not
finalised returns nothing, which draws as a collapse in traffic rather than as
an absence — so the sync ends the window three days back and the page says so.

### The isolation tests were vacuously true, and the mutation suite caught it

The first version asserted only that tenant A saw no rows belonging to tenant B.
Dropping `tenant_isolation` returns **zero** rows — RLS failing closed — and
`every()` over an empty array is true, so the test passed whether or not the
control existed. Three mutations survived, which is what that harness is for.
The tests now assert presence *and* absence, and the Search Console job policy
got a test of its own rather than being assumed to behave like the GA4 one.
**31 of 31 mutations killed.**

---

## §12 — the executive screen adapts to the range, and a ratio has a minimum population

Built 22 September 2026.

The executive screen was fixed. Whatever range the date picker resolved, it
rendered the same eight cards, all of them outcome metrics: cost per funded
deal, funded volume, funded deals, attributed share, the lender offer rate and
applications. That is a defensible screen for a quarter and a bad one for a day,
and the date picker had just made a day askable.

Two failures, and they compound:

1. **The outcome ratios divide by funded deals, and Spartan funds seven a
   month.** Asked about a single day, cost per funded deal, attributed share and
   the lender offer rate all divided by nought or by one. The screen became a
   row of em dashes that reads as a broken dashboard rather than as a question
   the day cannot answer — and where a denominator happened to be two, it
   rendered a figure, which is worse.
2. **Nothing on the screen moved within a day.** Leads, calls, connect rate and
   speed to lead are all ingested and were all on other screens. A short range
   therefore had nothing to offer even in principle.

### The screen is two blocks, and what is measurable decides which one leads

There is an activity block — spend, leads created, calls made, calls connected,
speed to lead, applications — and an outcome block, which is what was there
before. Both are always on the page; neither is ever hidden by the range,
because a metric that vanishes when the reader shortens the window is a metric
nobody can find again.

**What leads is decided by what can be measured, not by a number of days.**
Outcomes lead when every outcome ratio clears its population; otherwise activity
leads. This was chosen over a fixed boundary — "activity under 28 days" — for
three reasons: there is no constant to justify, the rule is the same one the
screen states in words when it withholds a figure, and a client with the volume
to support a cost per deal over a week gets one, which a day count would have
denied.

### A ratio has a minimum population, and it is a property of the formula

`packages/core/src/population.ts` declares which formulas need a population
before they mean anything, and what that population is called. The split is the
same one `metric-direction.ts` makes:

- **Whether a formula needs a population is a property of the formula.** There
  is no client for whom a cost per deal over two deals is stable. Declared in
  core, keyed on `formula_key`, with `RATIO_SHAPED` as the safety net for a
  formula somebody adds and forgets to declare — an undeclared *count* is
  ungated, an undeclared *ratio* is gated.
- **How large the population must be is a judgement about a client's volumes**,
  so it stays a config row.

The noun is declared with the requirement, in both numbers, because "fewer than
three" invites "three of what" and for a channel metric the answer — deals
attributed to *this* channel, not deals in the period — is the separation rule
restated where the reader is already asking.

Below the population the figure does not render. Not smaller, not starred, not
with a caveat beside it: the amber `Not measured` treatment every other
unmeasurable figure on these screens gets, with the population in the tooltip.

### `min_rate_denominator` now carries two floors, because it was two judgements

The config row existed and said, in its own description, that it was the
smallest denominator a rate may be **compared** against — the rate still renders
below it and only the delta is suppressed. Using it as the render floor was
tried and was wrong in the most visible way available: at 10, the ninety-day
view withheld **$8,629 over 9 attributed deals**, which is the figure this
product exists to report.

So the row carries both, because they are two different questions:

| | | Spartan |
| --- | --- | ---: |
| `minimum` | smallest denominator a rate may be **compared** against | 10 |
| `render` | smallest denominator the figure may be **drawn** over | 3 |

Three is the brief's own words — "rather than rendering a figure built on one or
two deals". `metrics.population()` resolves the render floor and
`metrics.comparable()` the comparison one; both take the denominator the card
actually divided by, and no screen names a formula or a floor.
`apps/web/test/population-gate-usage.test.ts` reads the sources and fails if one
does, exactly as `metric-direction-usage.test.ts` does for direction.

The comparison floor had been loaded by two screens and used by neither since it
was added. It is now wired to the baselines it was written for.

### Where every withheld ratio goes

**Into one card, not one card each.** Four amber badges in a row reads as four
failures; one card headed "Outcomes need a longer range", listing each metric
with its population and its floor and carrying a single action — show 90 days —
reads as what actually happened. The empty-state rule is one line plus at most
one action, and this is that rule applied to a block rather than to a card.

This applies whenever *any* outcome ratio is withheld, not only when all of them
are. Two withheld cards and one measured one is the same wall in miniature, and
the hero is the worst case: on a one-day range it was eight columns containing
two empty channel panels — a large confident card saying nothing.

**The gate is per channel, and the channel table obeys it too.** On ninety days
Google Ads carries nine attributed deals and Meta carries one, so the hero
renders Google's figure and withholds Meta's in its own panel, naming the
channel. `ChannelSnapshot` takes the same verdicts: a screen that declines to
state Meta's cost per deal above the fold and then prints it in a table four
hundred pixels below has not withheld anything, it has only made the figure
harder to find.

### Freshness, because hourly sync means "today" is as of the last run

A strip under the title, one entry per source, with the age of the last
successful sync and — where the range ends today — the time the figures are
actually as of. Amber past two hours, which is two missed runs on an hourly
schedule.

**Calls are the stated exception.** They arrive by webhook as each call ends, so
there is no run to be behind; the row reports the newest call received and is
never amber. A quiet Sunday on the phones is a quiet Sunday, and colouring it as
a fault would say the opposite.

**Only the sources this screen draws from are listed** — paid media that has
reported spend, the CRM, and calls. GA4 and Search Console are connected,
healthy, and back no figure here; five timestamps of which three are irrelevant
is a strip nobody reads.

### Three bugs this surfaced

1. **`max()` over a `timestamptz` comes back as text.** A plain column is parsed
   by the driver and an aggregate is not, and the difference was invisible until
   `.getTime()` threw on a server render. Coerced where the shape is declared.
2. **Calls had no ingestion boundary.** The call history starts on the export's
   first day, so the ninety days before a trailing-ninety-day window hold six
   calls against twenty-seven thousand — rendered as **+447,483%**, which is
   exact and reads as a desk that has transformed itself. It is an import date,
   and it now renders as one, like spend and the CRM already did.
3. **"0 connected channels" on a day with no spend.** `data.channels` is the
   channels that *reported* in the range; the line implied a disconnection that
   had not happened, and now says what it measures.

### Charts at a short range

`granularityFor` gained a day tier under three weeks, so a single-day range
resolves to one day bucket rather than to a week-wide column labelled with the
wrong period. The activity mini charts draw the trailing thirty days in day
buckets whatever the page range — the same argument the outcome cards' twelve
months make: the figure above already carries the range, and what a reader wants
under a daily number is where that day sits against the last month of days.

---

## §12 — the executive screen is a briefing, and the ramp is drawn on an M axis

Built 22 September 2026, replacing the range-adaptive screen of earlier the same
day. That version solved the right problem — the screen assumed a quarter and
broke at a day — with a control the screen should not have had at all.

### The date picker is gone from this screen

A briefing is a standing report. A screen two readers can rescope is a screen
two readers quote different numbers from, and "is the engagement on track" is
not a question about an arbitrary window. So the executive screen has no range
control and each block states its own period in words:

| Block | Period |
| --- | --- |
| Engagement ramp | the engagement, M1–M8 |
| Funded deals, volume, spend, funnel, efficiency | this month to date, with the last whole month beside it |
| Needs attention, data quality | current state |

This does not contradict "one date control per page, and it is
`DateRangePicker`" — zero is not two, nothing on the page can disagree about
what it covers, and monthly performance remains the screen for scrubbing.

**Month to date against a whole month is two different lengths on purpose.**
That is how a business talks about its own month. The mismatch is handled by
never subtracting a *count* in one from a count in the other: funded deals and
funded volume render as two figures with their periods under them, and carry no
delta. Rates and costs do compare, because neither scales with the number of
days. `TwoPeriodKpi` exists so that rule is a component rather than a habit.

### The ramp is plotted against M1–M8, not against a calendar

This is the change that makes the hero work at all. The contract says month
three of the engagement costs $3,496; it does not say when month three is. The
previous hero plotted the commitment on calendar buckets, so with the start
month unrecorded — which is where Spartan still is — it drew an empty chart
against a curve that had been fully specified since signature.

On a ramp-month axis the commitment is always drawable and the *actual* is the
half that waits. `rampSeries` in `packages/core` produces the pairing, and it
never asks for an actual while `startMonth` is null: asking anyway would align a
figure to a month nobody chose, and assuming the engagement began when ingestion
did is the exact mistake the start month exists to prevent.

### Only a completed month gets an actual, and only above the population floor

Caught by looking at the chart with a start month set for testing. September was
three weeks old, held one funded deal attributed to Google Ads, and plotted at
**$18,792 against a $3,321 target** — so the card reported the engagement as
catastrophically behind plan on the strength of a month that had not happened.

Two rules, both narrow:

1. **A ramp actual is a completed calendar month.** A ramp contracts a monthly
   result and three weeks of one is not that. The month in progress is not
   missing from the briefing — it is the three KPI cards immediately below —
   but it is not a point on a curve of monthly results, and the line under the
   chart says so.
2. **A month's cost is gated on its own denominator**, by the same
   `metrics.population()` the efficiency table uses. A point on a chart is a
   stronger claim than a cell in a table: a reader takes a line as a
   trajectory, and joining a one-deal month to the months either side draws a
   shape that is not in the data.

### All five contracted metrics render, and four of them have no curve

`engagement_targets` contracts budget, CPA, approvals, cost per funded deal and
funded deals. **Only cost per funded deal is entered (M1–M8), plus M1's budget.**

Cost per funded deal and CPA get full trackers; budget, approvals and funded
deals get a one-line strip. Each empty one carries an amber `Not recorded` and
names what is missing, because the difference between that and omitting them is
the difference between a dependency somebody can close and a feature nobody
knows exists — the data-quality card's argument, applied to the contract.

A partially entered curve says so: the budget strip reads `$30,000 · M1 only`
rather than `$30,000`, which would read as a monthly budget rather than as one
month of one.

### `min_rate_denominator`'s comparison floor is now load-bearing twice

Unchanged from earlier today, and worth restating because the briefing leans on
it harder: `render` (3) decides whether a figure is drawn, `minimum` (10)
decides whether it is compared. The efficiency table's funded-deal column
divides by one or two every month and is withheld; its cost-per-lead column
divides by 185 and is not.

### Efficiency is a table, because the metric is per channel

Cost per lead, per application, per approval and per funded deal, one row per
channel. Four metrics across two channels is eight cards, and the single blended
card that would fit the space is precisely what the separation rule exists to
prevent — a figure that improves when a *different* channel has a good month.

**Coverage rides on each cell, not on the row.** Google Ads can claim 185 of a
month's leads and one of its funded deals; those two figures are supported to
completely different degrees, and one coverage number per row would average them
and hide the thing worth seeing.

### Needs attention carries findings, not metrics

The distinction is the card's whole purpose. A metric is "speed to lead:
11h 37m". A finding is "leads wait for a first call — median over 639 of 1,457
called, 3.6% reached within five minutes". The second is what an account
director would otherwise put in an email, and it is what a briefing exists to
replace.

Five checks, none of them a threshold nobody agreed:

- **speed to lead**, with the five-minute share — the industry's bar, named as
  such rather than presented as this product's;
- **calls this month**, with the connect rate and the abandoned count kept
  outside its denominator;
- **campaigns that were spending and are now paused** — `REMOVED` is excluded,
  because a deleted campaign is one somebody cleaned up rather than a
  configuration left behind;
- **any connection degraded, failing or waiting on the client** — the last is
  `watch` rather than `act`, since a dependency is not a fault;
- **funded deals no channel can claim.**

Two levels, `act` and `watch`, and no third angrier one. A briefing that shouts
cannot be read.

### Budget pacing, and what it refuses to say

`budgetPacing` in `packages/core` reports where the month lands at the current
rate and the variance against budget. Three decisions in it:

- **No improvement direction.** Overspending is not a failure and underspending
  is not thrift; what the spend bought decides that. So `on_plan` is neutral and
  both `over` and `under` are amber — "look at this" — and nothing is ever
  green, which would read as a score.
- **`on_plan` is a band, not a point.** Five per cent either way. A card that
  says "over" because a month is tracking 0.4% hot is a card nobody reads by
  March.
- **An early projection is stated as early rather than withheld.** Below a
  quarter of the month elapsed one heavy day still swings it a long way;
  withholding it would leave the reader to do worse arithmetic in their head.

Where no budget applies the card still renders the spend, with the reason —
losing a measurement to protect a comparison is the wrong trade. Today that
reason is the start month: the budget sits on a ramp month and nothing says
which calendar month that is.

The header badge is `No budget set`, deliberately not the usual amber
`Not measured`: the spend *is* measured and is the largest figure on the card.

### The page refetches itself hourly

`export const revalidate = 3600` plus `AutoRefresh`, matched to the sync
cadence. It uses `router.refresh()` rather than a reload — a reload on a screen
somebody is reading is jarring and would replay the charts' entrance — and it
pauses while the tab is hidden, so a laptop shut over a weekend does not wake up
and fire forty requests.

### Removed with the old screen

`HeroCard`, `ChannelSnapshot`, `SpeedToLeadCard` and `GatedOutcomes` are gone.
The ramp card replaces the first, the efficiency table replaces the second, and
speed to lead is a finding rather than a card. They are deleted rather than left
unimported for the reason the retired offer rate was: dead code is one import
away from coming back.

### A bug this surfaced

`max()` over a `timestamptz` returns text where a plain column returns a `Date`,
so the freshness strip threw on a server render the first time it drew. Fixed
where the shape is declared rather than trusted at the call site.

---

## §12 — the engagement model is loaded, and its "CPA" is cost per approval

Loaded 22 September 2026 from
`data/private/SpartanCapital Google Ads Budget Projection for 8 Months(Sheet1).csv`.
All five contracted series now exist for M1–M8, so the four `Not recorded`
panels on the briefing fill.

| | M1 | M8 |
| --- | ---: | ---: |
| Budget | $30,000 | $316,241 |
| CPA | $750 | $524 |
| Approvals | 40 | 603.8 |
| Cost per funded deal | $4,000 | $2,705 |
| Funded deals | 7.5 | 116.9 |

Loading it changed two things in the code, and neither was optional.

### The model's CPA is budget ÷ approvals, and the briefing was measuring
### cost per application

The CPA column is not an assertion, it is a computation the model performs on
its own two other columns, and it reproduces to the dollar in all eight months:
$30,000 ÷ 40 = $750, $316,241 ÷ 603.8 = $524. So the **"A" is an underwriting
approval**.

The briefing measured the actual as cost per *application*. Against September
that is 121 applications where the contract means 41 approvals — the actual
would have rendered roughly threefold too low and drawn the engagement as
comfortably ahead of a target it is a long way behind.

**Two independent checks confirm the reading**, which is why it is stated as
fact rather than as an inference:

1. The model's own note says *"Current CPA is 2119 and CPF is 8227"*. Measured
   from the warehouse, August's Google Ads spend over August's Google Ads
   approvals is **$2,146**. Cost per application for the same month is $384.
2. The same note's CPF of $8,227 sits beside the trailing-90-day cost per funded
   deal this product already reports, $8,764.

The word CPA still means at least three different things across this
engagement's paperwork — the proposal says $2,000 falling to $1,000, the Google
Ads baseline reports cost per conversion of $108.59, and the model says
$750 falling to $524 over approvals. The `cpa_definition` reconciliation row
carries all three now; the third was added with this load and is marked as what
it is, a definition rather than a claim about a figure. **The `cpa` KPI metric
stays unreconciled. The ramp's CPA does not need to be**, because the model
defines its own column from its own columns, and that is the only definition the
ramp is drawn against.

### Contracted approvals and funded deals are fractions (migration 0021)

0020 typed both `integer`. The model contracts 7.5 funded deals in M1 and 116.9
in M8. Nobody funds half a deal — these are projections, and **the halves are
load-bearing**, because the model's internal arithmetic only reproduces with
them: $30,000 ÷ 7.5 is the contracted $4,000, while $30,000 ÷ 8 is $3,750, a 6%
error in the north-star target arriving as a rounding decision nobody made.
Truncating to 7 errs 14% the other way.

Both columns are now `numeric(18, 2)`. The migration writes no rows, so it needs
no `NO FORCE` bracket — that rule is about DML, and `ALTER COLUMN ... TYPE` is
DDL that runs as the table owner and is not subject to row level security.
Verified either side: 8 rows before, 8 after, every existing figure intact.

**`formatProjection` is a separate function from `formatCount`** for the same
reason. A count of things is a whole number and a cell reading "7.5 deals" would
be a measurement claiming something impossible; a contracted projection is the
opposite case, and rounding it on screen restates the contract. The ramp strip
reads `7.5 → 116.9`, not `8 → 117`.

### The figures are in the seed, not parsed at load time

`data/private/` is gitignored, so a parser would make the seed unrunnable on a
fresh checkout and in CI. They are transcribed into `spartan.ts`, where a
reviewer can read them in a diff, which is how the cost-per-funded-deal curve
already worked.

That leaves hand-transcription as the risk, and a wrong digit in a contracted
target is close to undetectable by eye — the curve still looks like a curve.
`packages/db/test/engagement-model.test.ts` closes it by exploiting the model's
redundancy: budget, approvals and funded deals are the primitives, CPA and CPF
are derived, so re-deriving both is a checksum over all five columns. It also
checks the sums against the source's own TOTAL row, that both costs decline and
all three volumes grow, that the fractions survive, and that only Google Ads
carries a curve.

**Its tolerance is derived rather than chosen**, which is worth recording
because the first version got it wrong. The model rounds twice: the ratio to
whole dollars (±$0.50) and the *count* to one decimal (±0.05 of a deal, divided
into the budget). The second dominates and is far larger early — 0.05 against
M1's 7.5 deals is 0.7% of the denominator, against M8's 116.9 it is 0.04% — so
the allowance is `$0.50 + ratio × 0.05 / count`, which is $27 at M1 and $1.66 at
M8. A flat $0.50 failed five of the eight months with correct data; a flat $27
would let a real error through at M8. A test asserts the checksum would catch a
single mistyped digit.

### What the model states and this schema does not hold

`Funded Amount` (M1 $80,000 rising to M8 $2,338,073) and `Avg. Deal Size`
($20,000 from M2) are in the source and have no column in `engagement_targets`.
They are not loaded rather than being loaded somewhere approximate. The
`funded_targets` reconciliation row already covers the disagreement between the
proposal's funded-volume figures, and this is a fourth source for it.

---

## §12 — the funnel row is a funnel, not seven differently-shaped cards

Rebuilt 22 September 2026, on both screens that draw it — the executive
briefing and the funnel view share one component, so the fix is one fix.

### The card grew a line per caveat, and stopped reading as a number

Each stage card had accumulated a line for every qualification that applied to
it: the grain it counts at, deals that were later declined, the coverage horizon
where the source has one, and the share of leads the qualification bar could be
evaluated against. Each line carried its own ⓘ, so `UW approved` rendered four
lines and two tooltips while `Funded` rendered two lines and one. Seven stages
came out seven different heights, and the eye could not find the figures among
the qualifications.

**The card is now three fixed rows — label, figure, one supporting line — and
one ⓘ.** The rows have explicit minimum heights and the card an explicit
minimum height, so every card is 124px at every width, including on a wrapped
row. `items-stretch` equalises within a flex line only, which is why a fixed
height was needed rather than left to the layout: at 1024px the first row came
out 34px taller than the second.

The supporting line always says what the figure counts — `inbound leads`,
`leads past the bar`, `opportunities` — and nothing else, so it is comparable
across the row. Everything that used to be its own line is in the tooltip,
composed in priority order rather than concatenated: the first sentence says
what the number counts with the origin or horizon folded in as a clause, and
the second is whichever single caveat matters most. Two sentences, which is the
budget §2 sets for an ⓘ. The full text is also in the accessible table, which
prints, so nothing moved behind a hover only.

### The blue top border was colour as the only encoding

Three cards carried a blue top border and nothing said why. It marked
`is_optimization_target`, which is a real and useful fact — these are the stages
the engagement is judged on — but encoding it in a colour alone breaks the rule
this product applies everywhere else, and it read as decoration.

The border is gone. A target stage says `· target` on its supporting line, which
is text, survives a greyscale print, and is explained in the card's ⓘ.

### A bare em dash is the wrong way to withhold a rate

Four of Spartan's six transitions carry no conversion rate, for four different
reasons, and each rendered as `—` with the explanation behind a tooltip. A dash
reads as missing data. It is the opposite: a deliberate refusal, because the
later population is not drawn from the earlier one and their ratio would not be
a conversion rate.

Every gap now carries words:

| | Chip | Why |
| --- | --- | --- |
| Lead → MQL | `11.5%` | both sides at lead grain |
| MQL → Application | `not a gate` | MQL is computed from what a lead reported, so an unqualified lead can still apply |
| Application → SQL | `95.9%` | nests within the configured tolerance |
| SQL → UW approved | `not nested` | 5 of 41 never reached SQL |
| UW approved → Offer | `not nested` | 2 of 18 have no approval event |
| Offer → Funded | `not nested` | none of the 3 funded deals has an offer event |

The specific numbers stay in the chip's ⓘ. On the funnel view, where the
retired deal-level offer rate is passed in as a suppressed transition, the same
chip reads `retired`.

### Widths were measured, not eyeballed

The first attempt gave the connector column 74px, which is narrower than the
chip inside it: the words overflowed both edges, sat on top of the cards and
truncated to `not neste` — worse than the dash. The row is a budget, so it was
solved as one. At 1440px the card has about 1,080px of usable width; seven
cards at a legible minimum and six connectors wide enough to hold two short
words leaves 54px per connector and about 108px per card. The arrow went from
the rate chip to buy the figure a character, and the funnel reads left to right
without it.

Verified by measurement at 1440, 1280, 1024, 768 and 390px: every card exactly
124px, no chip overflowing its column, no clipped text, no label colliding with
its ⓘ, and no horizontal page scroll.

## §8 — funded deals: the tenant's month, no renewals, the funded amount

Decided 23 September 2026, after an audit reconciled every funded Opportunity
in August and September against Salesforce one by one. The count was right —
Aug 7 and Sep 4 by `csbs__Funded_Date_Time__c`, agreeing with the stage history
and the auto-created Contract — and four things around it were not.

- **Months are the tenant's.** Reports bucketed instants by the UTC day, so
  anything after 8pm Eastern on the last of a month counted in the next.
  Migration 0024 stores a tenant-local date beside every instant a report
  reads, written at ingest, which is what the convention always said.
  `@zeeraa/db`'s period predicates are the only comparison of a range with a
  date.
- **Renewals are not funded deals.** Renewal, Renewals, Addon, Win Back,
  Winback and Existing Business on the Opportunity `Type` field are excluded
  from funded counts, funded volume and every cost per funded deal — the
  client's list, in the `stage_exclusions` config row. The event is kept with
  `excluded_reason` so the exclusion is auditable. `Type` is blank on 562 of 734
  opportunities, so an unlabelled renewal still counts; "Renewal Prospecting"
  is **not** a marker — reps click through it on new deals.
- **Volume is `csbs__Funded__c`**, the selected offer's funded amount, not
  `Amount`, which is what was asked for.
- **A corrected date is a third origin.** Onu Ventures funded in May; the rep
  could move it to Funded only by backfilling a submission, an offer and a
  contract on 1 September, and the dated fields are either that backfill or a
  copy of `CloseDate`. `stage_corrections` records it as `origin = 'corrected'`
  with month precision and a source, and the data-quality card lists it. A
  corrected event is neither observed nor computed and must never be presented
  as either.

Four other deals show backfilled lender paperwork (Turn Clean Pros, E&D
Transform, OHS Contracting, Challenger Telecom) but land in the month they were
worked, so no correction was recorded for them.

## §12 — the engagement model governs every target

The M1–M8 engagement model is Zeeraa's committed target sheet (client decision,
23 September 2026). Cost per funded deal, funded volume and CPA are no longer
awaiting reconciliation: each month's target is that ramp month's row in
`engagement_targets`, which now carries the model's Funded Amount. CPA is cost
per UW approval, as the model computes it. The proposal's figures —
$4,500 within 30 days, $100–150K in month one, $2,000 → $1,000 CPA — are
superseded, and the two reconciliation items are resolved rather than deleted.

## §12 — the executive screen takes the date picker, and controls are chrome ink

Three reversals of the 22 September design, each at the client's request.

- **Executive has the `DateRangePicker`**, defaulting to month to date. The
  measured figures follow the range; the comparison is the last whole month
  while the range is month to date, otherwise the equal-length period before.
  The ramp still covers the engagement on its M axis and never reads the range,
  pacing is always this calendar month, and counts across the two periods are
  still never subtracted. Every ratio remains gated on its own denominator, so
  a one-day range withholds cost per funded deal rather than dividing by one.
- **Controls are chrome ink, not blue.** `--color-primary` is the rail's
  near-black, 18.1:1 on white. Ink cannot be told from body text by colour, so
  every link carries a permanent underline (`.link`). Gold is unchanged: the
  active nav item and nothing else.
- **The black title band is gone.** The rail alone is chrome. The top bar is
  light, the breadcrumb's last item is the page title, and the h1 is kept for
  screen readers only.

Also: Sync now reports in a toast labelled per connector, failures marked by
icon and word as well as colour and never in green or red; and the rail shows
the tenant's own logo from `tenants.logo_data_url` (migration 0025, set by
`set-tenant-logo.ts`), stored on the row so it is policy-protected and has no
public URL.

## §8 and §12 — funded deals are dated by the timestamp, and unread ranges are named

Decided 23 September 2026.

- **Funded is dated by `csbs__Funded_Date_Time__c`**, the stamp, and a late
  entry is corrected per deal in `stage_corrections` (Onu Ventures is the
  first). `csbs__Funded_Date__c` was proposed as a business funding date and
  rejected: it equals `CloseDate` on all 22 deals that carry it, and `CloseDate`
  is the creation day unless somebody edits it, so it records when the deal was
  opened rather than when it funded.
- **No zero for a range past a source's last read**, on any screen or in the
  export. A range after the last successful sync — or, for GA4 and Search
  Console, after the last published day — renders the named `Not measured`
  state with the source and the day; a range running past it says where its
  figures stop; a comparison period is held to the same rule, so a delta is
  never drawn against an unread baseline. Rules in `lib/coverage.ts`, guarded by
  `coverage-usage.test.ts`.

## §11 and §14 — only a Zeeraa admin administers accounts

Decided 23 September 2026, after a client admin was found able to see People
and remove Zeeraa users. It was worse than it looked: `users_admin_manage`
(0017) let a client admin reset the password of anybody sharing their tenant,
Zeeraa admins included, and the reset hands back the new password — an account
that reaches every client. The suite asserted that case as passing.

Client admins now have no People access at all. `canManageUsers` is
`zeeraa_admin` only, so the rail drops the link and the page and every server
action refuse; migration 0027 narrows every account policy to `zeeraa_admin`,
so the database refuses the same calls made without the application. A tenant
always keeps one Zeeraa admin: a trigger refuses removing the last one by
membership or by account deletion, for every role.

This reverses the 21 September decision that let client admins add their own
people ("a client waiting on Zeeraa to add their own new hire is a support
ticket"). The cost is exactly that support ticket.

## §5 — membership reads; only ingestion and Zeeraa admins write

Decided 23 September 2026, closing both database-level findings of the People
audit (migration 0028). `tenant_isolation` on the 29 tenant data tables is now
FOR SELECT; writing needs `tenant_admin_write` (Zeeraa admin in the tenant) or
the ingestion role's own policies. A user's own account row changes only
through the change-password flow, and only its password. Client admin and
client viewer remain separate roles with identical access.


## §7 and §9 — speed to lead runs on the desk's hours

Requested 23 September 2026. Speed to lead, its p90 and "called within five
minutes" were on a 24/7 clock, which charged Spartan's desk for every night and
weekend a lead sat through. They now run on the `lead_response_hours` config
row: the clock runs only while the desk is open (9am–6pm Eastern, Monday to
Friday, for Spartan); a lead that arrives outside hours starts its clock at the
next opening; a call before the opening is a zero wait; a holiday is a closed
day. The holiday list is empty until somebody records one.

The arithmetic is `businessSecondsBetween` in `packages/core/src/business-hours.ts`.
Both clocks go through `responseSeconds`, so the business figure and the 24/7
figure beside it cannot drift apart. `callReport` and `callSeries` read the row
in their own transaction rather than taking it as an argument, so no screen can
compute a response time on a clock it does not state. With no row, or one that
does not parse, the clock is 24/7 and the card says so. It never guesses hours.

The card states its clock ("business hours · 9–6 ET, Mon–Fri") under both
figures, and keeps the 24/7 median as a secondary line so the change can be
traced. The executive finding carries both.

Not `working_hours`. That row, seeded in phase 1 and never read, is Zeeraa's
own availability to the client under the brief's SLA (9–3 ET, federal holidays
excluded). It is a different fact about a different party.

Measured against production on 23 September, before the row was loaded (every
called lead, the same 4,015 leads on both clocks):

| | 24/7 | Business hours |
|---|---|---|
| Median | 2d 15h | 12h 56m |
| p90 | 123d 6h | 33d 1h |
| Within five minutes | 9.6% (385) | 10.0% (403) |

Month to date: median 11h 50m → 3h 15m, p90 3d 22h → 1d 2h, within five
minutes 3.4% → 3.6% over 670 leads. The median falls by a factor of three to
five, but the five-minute share barely moves: 3,327 of 4,015 waits ran through
closed hours, and only 144 leads were rung before the clock started. Even on
the desk's own hours, very few leads get a call within five minutes.

## §12 — the ramp is drawn on the calendar once M1 is recorded

Requested 23 September 2026, with M1 recorded as **October 2026**. This reverses
the rule that a contracted curve is never plotted against a calendar. That rule
existed because the start month could be unset, and a curve drawn on a calendar
axis could not be drawn at all until somebody recorded it. That is still true
before the start is recorded, and `rampSeries` still draws M1–M8 then. Once the
start is recorded, the calendar axis is drawable, and it carries the argument
the M-axis could not: where the client was before Zeeraa.

`rampTimeline` in `packages/core/src/ramp.ts` produces, per contracted metric:

- **Baseline · before Zeeraa**: the six calendar months before M1, measured by
  the same arithmetic as the engagement months, as a solid line. Six fit
  fourteen months on a phone. Spend is synced only from June 2026, so April and
  May read Not measured on the spend-based panels.
- **Engagement starts**: a marker on the boundary of M1.
- **Target**: M1–M8 from the engagement model, dashed with hollow dots and
  labelled on the line.
- **Finished months**: the actual, solid, with a bar from actual to target and
  a signed, arrowed gap under the chart. Green and red come from the metric's
  declared direction. Budget declares none, so its gap reads over or under and
  is never coloured.
- **The month in progress**: a hollow dot on a dotted link, never joined to the
  line and never compared with a monthly target.
- **A month with no figure**: an amber hatch, and a `Not measured` line naming
  the months and the reason (spend not synced, Salesforce not synced, or the
  population floor). Never a zero. A count in a synced month is a measurement
  even at zero.

Measured and contracted are told apart by line style, marker and on-chart
label, not by colour.

**Every target is Google Ads only, and so is every actual.** The model is
"SpartanCapital Google Ads Budget Projection for 8 Months": budget is Google Ads
spend, CPA is that budget over approvals, CPF is budget over funded deals, and
funded amount is funded deals at the model's average deal size. The actuals take
the ramp channel's own spend and its own attributed approvals, funded deals and
funded volume. A deal is attributed to Google Ads by its gclid, which Salesforce
keeps, so the pre-June baseline months are real counts even though click-level
data starts on 20 June. Each chart's title, target line, key and basis line name
the channel from the ramp's platform, not from code.

One inconsistency in the model is recorded, not corrected: M1's Funded Amount is
$80,000 with an average deal size of 0, where 7.5 deals at the $20,000 used from
M2 on would be $150,000. The target is the model's figure.

Pacing no longer says a month before the start "falls outside the contracted
ramp". It says the engagement has not started.

## §7 and §16 — the accuracy audit, and what it changed (23 September 2026)

An audit before the engagement starts reconciled August and September on every
screen against each source's own API: Google Ads, Meta, GA4, Search Console,
Salesforce and the Aloware export. August matched everywhere. September
differed for five reasons, all fixed:

| Finding | Cause | Fix |
|---|---|---|
| Meta 19–20 Sep and GA4 19–20 Sep had no rows; 18 Sep was stored mid-day | The hourly run pulled a fixed two days, stopped starting work at 45s with Google's per-day `click_view` first, and recorded nothing for a skipped platform. The nightly 90-day re-pull the brief requires was never scheduled. The cron itself barely fired (three runs in eight days) | A per-day read ledger (`sync_days`, 0030); each source resumes from its oldest day not read final; spend first, clicks last; `skipped` runs recorded; a nightly re-pull on its own daily cron |
| Google Ads September conversions 4 short | Restated by Google after our last read of those days | The nightly re-pull |
| 45 September leads counted that Salesforce had merged away | The reconciliation marked `merged_into` and every count ignored it | A merged lead is excluded (`excluded_reason = 'merged'`) |
| Calls 18–21 Sep absent, drawn as a quiet desk | The export ended 17 Sep and the webhook began 22 Sep; coverage looked only at the newest call | The missing export imported; calls on the ledger; coverage by day |
| September funded 3 vs Salesforce's 4 | Onu Ventures, re-dated to May by the client's decision | Correct by design; reconciliation marks it `explained` |

Rules the audit found broken and fixed: pacing counted every channel's spend
against the Google Ads budget; ramp cost-per-deal lines had no coverage or
range; performance month-over-month drew a cost per deal of 0 for a month with
no deal; population gates were missing on the performance, platform and funnel
screens (verified, then applied); renewal submissions were in the lender offer
rates (`submissions.excluded_reason`, 0031); GA4 "users" summed daily users,
which GA4 does not add up — it is now GA4's own monthly figure.

**The model's baseline** ($2,119 CPA, $8,227 CPF) reproduces to 0.5% as Google
Ads spend ÷ Google Ads-attributed UW approvals (31) and funded deals (8) over
1 June to about 29 August 2026 — the same definition the product uses, pooled
over three months where the ramp shows single months. Our June lacked 1–20 June
spend until it was backfilled.

**Coverage is by day.** A range with an unread day is partial and names the
days; a range with every day unread is Not measured; charts leave unread days
blank. Salesforce keeps its watermark rule.

**Daily reconciliation** (`reconciliation_checks`, 0032): each source's own
totals for last month and this month to yesterday against ours, with the
differing days or records named, on the Connections screen. An hour after the
nightly re-pull.

**Baseline freeze** (`baseline_snapshots`, 0032): June–August 2026 frozen after
the audit; September freezes itself five days after it ends if that day's
reconciliation is clean (`baseline_freeze` config row). Append-only for every
role: no update or delete policy, and a trigger that refuses both even to a
role that bypasses row level security. A correction is the next version with a
reason. The ramp reads a frozen month from the snapshot; the figures are
computed by `channelMonthActuals` in core, the same function the live ramp
uses, so a frozen month is what the ramp showed.

## §12 — the executive ramp is a scorecard and one chart (24 September 2026)

**The client found the ramp section too complex, and it is replaced.** The
executive screen now draws a four-figure scorecard for this month against its
target — cost per funded deal, CPA, funded deals and spend, all Google Ads —
and one chart: Google Ads cost per funded deal, its baseline months, then the
M1–M8 target. There is no legend on it, no basis line and no badge stack. The
chart names its own lines ("Actual", "Target"), a month with no figure is a
gap with its reason on hover, and every definition is in the page's one "How
this is measured" drawer. CPA, budget, approvals, funded deals and funded
volume are drawn in full on Monthly performance, from the same panels
(`lib/ramp-panels.ts`).

**This departs from "the month in progress is never compared with a monthly
target"** for the scorecard only. A client asked what this month says against
its target is owed an answer, so the scorecard gives one, and it is fair to the
partial month rather than silent about it:

- a **count or a spend** is judged against pace — the target times the share of
  the month gone, the straight line `budgetPacing` already uses — and withheld
  as "too early" below a quarter of the month;
- a **cost** needs no pro-rating, because it is already per deal, but it is
  judged only above its comparison floor (`metrics.comparable`), so a cost
  over two deals is never "behind by $4,000";
- **within 5% is on target** (`PACING_TOLERANCE`), and ahead of target also
  reads "on target", because these screens are a record rather than a report
  card;
- **spend is over or under, never behind**: it declares no direction.

The rule is `scorecardVerdict` in `packages/core`, tested there. The chart is
unchanged in this respect: its partial month is still drawn apart and never
assessed.

## §12 and §16 — thirteen client-facing fixes, and three rules reversed (24 September 2026)

The audience is a non-technical client. Where the data cannot support
something, it is now **hidden** rather than shown as a dead control or an
amber badge. Three standing rules changed to allow that, each on the client's
explicit instruction.

### The minimum-deal rule no longer applies to costs

**Reversed.** Cost per funded deal, CPA and every cost-per-stage figure always
show their number, with what they were divided by beneath it ("Based on 1
deal", "185 leads"). Only an empty denominator has no figure, and it says "No
deals yet" — never "Not measured". `needsPopulation` in
`packages/core/src/population.ts` returns false for anything cost-shaped
(`cost|cpa|cpc|cpl|cac`), declared or not, so no call site can bring the gate
back; `population-gate-usage.test.ts` fails if a screen passes a cost through
`metrics.population` or `metrics.comparable` again.

**Rates keep their floor.** A 100% offer rate over one decision is not a
statement about a lender, and the client asked about costs. The
`min_rate_denominator` row still governs `submission_offer_rate`,
`attributed_share`, `speed_to_lead` and the other rates.

**The plausible range is gone from the cost line.** It was analyst detail; a
cost per deal now carries its coverage and not its range. Frozen baseline
snapshots taken before this change may still hold a null figure for a month
under the old floor; they are append-only, and a correction is the next
version with a reason.

### The funnel shows a real percentage between every stage

"Not a gate", "not nested", "retired" and "over 100%" are gone. Between every
pair of measured stages is this period's count at the later stage divided by
the earlier one's, and the hover says in one sentence what the two counts are
— including when the later one is larger because deals reach it without
passing the earlier one in the period. This is a ratio of two counts, not a
cohort conversion rate, and it is labelled as such in the hover rather than
withheld.

### The Data quality card is Zeeraa staff's, not the client's

The card, and its items in the "How this is measured" drawer, render only for
`zeeraa_admin` (`canAdministerTenant`). A client reads a list of what cannot be
measured as a list of failures. Three of its items became measured figures
(`lib/quality-measures.ts`, last 90 days, with coverage): the lender-level
offer rate, revenue in one merged set of bands (`leads.revenue_band`,
migration 0034, filled by `readRevenueBand` at ingest and
`backfill-revenue-band.ts` for earlier leads), and decline reasons from the
best-populated field a value sweep found — `Decline_Reason__c` on the lender
submission, 13.1% of submissions, with "Declined by Lenders" as the bucket for
declines with no reason. MQL coverage was removed. The four
`blocked_dependencies` rows and the retired deal-level `offer_rate` metric were
deleted by `apply-client-fixes.ts`.

**Revenue bands, merged.** The forms ask in three vocabularies whose edges do
not line up (under $10k / $10–20k / $20–50k / $50–100k / over $100k on the main
form; under $15k / $15–35k / over $35k on an older one). The merged set is the
main form's, in `revenueBandEdges` on the connection mapping, and an answer
that spans two bands is stored as `unplaced:spans_bands` and counted in the
coverage line rather than split or rounded.

### The rest

- **Test lenders** are excluded at ingest by the `lender_exclusions` config
  row, matched on the lender account id, so they leave every lender table,
  rate and total.
- **Breakdown** slices by Campaign (Google Ads by the lead's click, Meta by UTM
  campaign), Industry and State (the Lead fields a value sweep found at 39.1%
  and 35.7%). Product is not offered: the only product field holds `MCA` on
  4.9% of deals. A tab with no data in the period is not drawn.
- **Monthly performance** has one date control: the "Trailing window" month
  selector and the "Previous period / Last year" toggle are gone, and figures
  compare with the equal-length period before. The ramp is one table with a
  ✓ or "behind" per cell, judged by `scorecardVerdict`.
- **Toolbars** top-align their controls and put the date picker first on
  every page. "Take the tour" is a button beside the avatar.
- **Calls per month** and **Declines** label every bar with its month and
  count and mark a partial month; declines start when lender submissions do.

## §7 — Salesforce reads on the desk's hours (24 September 2026)

§7 has Salesforce hourly; since 23 September it ran every ten minutes around
the clock, and every open dashboard refreshed on the same cadence. Neon
suspends a compute after five idle minutes, so a ten-minute cadence kept it
running about half of every night and weekend. The Free plan's 100 CU-hours a
month would have run out: about 94 at 0.25 CU from the crons alone, and ~117
with one tab open through the working day.

Now Salesforce is read every ten minutes while the tenant's
`lead_response_hours` desk is open, and hourly otherwise. `salesforceSyncDue`
and `nextRefreshAt` in core are the rule for the cron and the page alike.
Vercel Cron has no timezone, so `vercel.json` fires `/api/cron/salesforce`
every ten minutes over the fixed UTC window `13-22`, weekdays, which covers
9–6 Eastern in EDT and EST, and on the hour outside it. The route then syncs a
tenant only on the hour's first tick or while its desk is open.
`apps/web/test/salesforce-schedule.test.ts` walks a year of ten-minute steps
against the seeded hours to hold the window to that. A tenant with no
`lead_response_hours` row is on the 24/7 clock and keeps ten minutes around
the clock. An open page refreshes at hh:02 outside hours, just after the hourly
sync, so it wakes the database when the sync already has.

## §8 and §12 — organic search as a source, and six client-facing fixes (24 September 2026)

**Organic/SEO is a source on proof, and only then.** A value sweep of the
4,750 inbound leads since June found the evidence that holds. The lead's
referrer (`referral_url__c`) is a search results page, and it has no click ID,
no `utm_campaign`, and no `utm_medium` other than `organic`. That is 62 leads,
and 1 of the 23 deals funded since June. Salesforce's `Referrer_Source__c`
cannot be used: 1,247 of its 1,313 `google_organic` leads carry a gclid and
`utm_medium=cpc`. `LeadSource`, Pardot's first-touch and search fields and
`Opportunity_Source__c` say nothing, and GA4 has no per-lead key. The test is
`isOrganicSearch` in core, and its hosts are the `organic_search_evidence`
config row. A lead's source is stored at ingest as `leads.channel` (migration
0035). A deal is organic only with no paid touch and an organic lead
(`buildAttribution`). Everything else stays unattributed. Organic buys nothing,
so every spend and cost cell for it is an em dash, never $0. The `Not a channel`
badge is gone. The unattributed row keeps its heavier rule.

**The frozen June–August unattributed counts are restated, not left to
disagree.** The organic leads and deals leave `unattributed`, so each changed
figure gets the next version with its reason
(`freeze-baseline --correct-channel-figures`), and organic's own figures are
frozen beside them.

**"Waiting on a lender reply" counts open deals only.** Lenders leave a
submission at `Submitted` when a deal ends without their answer. 570 of the 624
in the default window were on deals Salesforce had closed. `pendingState` in
core splits undecided submissions three ways: waiting (the deal is still open,
from `opportunities.is_closed`, Salesforce's `IsClosed`), no reply before the
deal closed, and not completed. The headline and the table's Waiting total are
the same number.

**Declines add up.** The bars are the headline's deals, over the picked window
only. Each deal is placed in the month of its first decline in the window
(`declines.byMonth`), where before it counted in every month it was declined,
over twelve calendar months. The card names two counts: deals declined, and
lender decline responses.

**Monthly performance KPIs.** A previous period that starts before the first
day of paid media shows no comparison at all. That day is when the data starts
for all three cards: funded deals before it thin to one a month, which is how
22 against 2 printed +1,000%. The mini charts start at that month.
"Provisional" is now a quiet hover: "Recent days may still update."

**Executive.** "All funded this month" sits above the scorecard, one row per
source, adding to the total. The scorecard is titled for its channel ("Google
Ads vs target"), because the targets are contracted for one channel.


### The source rules, as approved (24 September 2026, same day)

The first cut credited SEO/Organic from a search referrer alone, and GA4's
landing-page property (534284278) showed why that was wrong. Sessions tagged
`utm_source=100A00` land from Google Ads links that carry `gbraid` and no
gclid, and 48 of the 62 "organic" leads carried it. The rules are now
`lead_source_rules`, applied in this order by `leadChannel` in core:

1. A click ID: that platform.
2. gbraid / wbraid (`Gbraid__c`, `Wbraid__c`): Google Ads.
3. `utm_source=100A00`: Google Ads. (Withdrawn the same day; see the next
   section.)
4. Lead Source `Meta Ads` (Meta's own lead forms, no fbclid): Meta.
5. A paid UTM: the channel its `utm_source` names.
6. A lead vendor (Popcrumbs, Lendfax, Leadpop, LendingTree): its own named source.
7. SEO/Organic: referred from www.spartancapitalgroup.com or a search results
   page, with no paid signal. "Leads that came through the Spartan website or
   from Google search, not from ads."
8. Otherwise Direct & other. The label replaces "Unattributed".

ZoomInfo is outbound and is excluded like cold outreach: a `leadSources` rule
in `lead_exclusion`, applied to stored leads by `leadSourceExclusion`. A deal
with no click touch takes its lead's source, so Google Ads gains the deals
whose leads carry `100A00` or a gbraid. The frozen June–August figures are
restated as new versions, with the reclassification as the reason.

Production, June–September:
- **Leads.** Google Ads 1,298 → 1,654. Meta 618 → 1,751, most of the gain in
  September (45 → 1,140), when Meta's lead forms began. Popcrumbs 645, Lendfax 157, Leadpop 32 and
  LendingTree 1 are new sources. SEO/Organic is 59. Unattributed 2,834 becomes
  Direct & other 399, and 52 ZoomInfo leads are excluded.
- **Funded deals.** Google Ads 10 → 18, SEO/Organic 2, Popcrumbs 1, Meta 1,
  and Unattributed 12 becomes Direct & other 1.


### `100A00` is not Google evidence (24 September 2026, corrected the same day)

The approved rules treated `utm_source=100A00` as Google Ads. It isn't: the
landing page both ad platforms send traffic to sets it. Of the 715 `100A00`
leads, 191 (27%) carry Google evidence, 94 (13%) carry Facebook or Instagram
evidence, and 430 (60%) carry neither. Seven of the eight funded deals that
moved to Google Ads on it had no Google evidence: one was Meta (an fbclid on
its referring URL), and six were Direct & other.

The rule now credits Google Ads only for a gclid, a gbraid or wbraid, or
`gclid`, `gbraid`, `wbraid` or `gad_source` on the referring URL, or a Google
UTM. It credits Meta for an fbclid, a Facebook or Instagram referrer, a Meta UTM
or Meta's lead forms. `100A00` alone credits nobody, and it rules out
SEO/Organic, because it marks a visit through an ad page
(`unknownPaidSources`). June–August is restated as new versions with this as
the reason.

Production, June–September:
- **Leads.** Google Ads 1,654 → 1,338, Meta 1,751 → 1,858, Direct & other
  451 → 655. SEO/Organic is unchanged at 59.
- **Funded deals.** Google Ads 18 → 11, Meta 1 → 2, Direct & other 1 → 7.
  The deals that change: OHS Contracting, Kenura Angel Services, THUD
  Roofing, Personal Auto Repair & Detailing, The flavor pharmacy and Petway
  Trucking go to Direct & other, and Yessica cleaning and painting goes to
  Meta.

**Spartan's `Gbraid__c` and `Wbraid__c` are empty.** The apply form has those
values in its URL but doesn't write them, so an iPhone Google Ads click whose
landing URL isn't the referrer falls in Direct & other.


## §12 — the dashboard is cached between syncs and streamed (24 September 2026)

Pages were 1.4–2.7 s: every report was recomputed on every request, and the
Funnel's Breakdown ran one 1.9-second statement after the main batch. Now:

- **A between-syncs cache** (`apps/web/src/lib/report-cache.ts`). A result is
  keyed by tenant, role, local day, arguments and the tenant's data version,
  the newest write any report can read. It is served only to a request that
  has passed `requireTenant` for that tenant and role, so isolation still rests
  on row level security at computation time and on membership at serving time.
  A sync that finishes moves the version, so the next request recomputes. An
  entry also expires after ten minutes, as a backstop for a config edit in
  place that nothing timestamps.
- **An index**, `ad_clicks (tenant_id, click_id)` (0037), for the Breakdown's
  lead → click join. The planner misestimates under row level security (20
  rows for 3,910) and chose a nested loop. It now does index lookups.
- **Streaming.** "Needs attention" on Executive, and Call tracking and
  Breakdown on Funnel, are separate `<Suspense>` sections, and the call report
  no longer waits on its threshold before the rest of the page starts.

No figure changes: the report functions are unchanged and the number checks
call them directly.

## §9.3 — every funnel rate is a cohort (25 September 2026)

**Reverses** "The funnel shows a real percentage between every stage" above,
which divided this period's count at the later stage by the earlier one's and
explained in the hover when that passed 100%. Meta over the last 90 days read
114.3% from UW approved to Offer: eight offers against seven approvals, one on
an approval from before the window. The client's rule is that no conversion
rate exceeds 100%.

Now each rate between two stages is **a cohort**: of the records reaching the
earlier stage in the window, the share that have reached the later one so far,
at any date. `stageCohorts` and `cohortConversionRate` in `packages/core/src/funnel.ts`;
`monthlyPerformance` carries `cohorts` on every channel, the unattributed row
and the total. A lead-grain cohort (Lead, MQL) is asked about an opportunity
stage through `leads.converted_opportunity_id`, and the population is the
earlier stage's record's, so a channel's rate is its own records throughout.
The hover is one sentence: "Of the 7 deals that reached UW approved in this
period, 7 have reached Offer so far."

Two consequences worth knowing:

- **A recent window reads lower** until its deals have had time to move. The
  drawer says so.
- **"So far" includes a later stage recorded first.** 28 of the 123 deals
  approved in the last 90 days have their offer stamped before the approval,
  and every one has an offer, so UW approved → Offer reads 100.0% for every
  population. MQL → Application falls most (all sources 29.9% → 20.2%): it no
  longer counts applications from leads created before the window.

The deploy's number checks now fail if a cohort's size differs from its card's
figure, or any rate leaves 0–100%. Stage cards read "deals" under an
opportunity-grain figure, not "opportunities · target"; the target is in the ⓘ.

## §11 — "Sync now" for every member, throttled per tenant (25 September 2026)

§11 and the build so far gave "Sync now" to `zeeraa_admin` alone. Client
admins and client viewers now have it on Executive, Monthly performance and
Funnel (`canSyncNow` in core admits every role; Connections' per-connector
button stays Zeeraa-admin). Three things keep that safe:

- **The sync runs as the ingestion role.** The route resolves the tenant from
  the viewer's own membership (`requireRole`) and hands only its id to
  `runManualSync` in `@zeeraa/jobs`, which works under `withJobTenant`. A
  client gains no write of any kind; row level security scopes the throttle's
  read and the sync's writes to that tenant. An empty tenant id is refused,
  because `runIncrementalSync` without one syncs every tenant.
- **At most one manual sync per tenant every five minutes** for every role but
  `zeeraa_admin` (`manualSyncVerdict` and `isManualSyncThrottled` in core). A
  Zeeraa admin is exempt, so a connector can be re-checked at once; their run
  still starts the clock for everyone else, and still takes the lock. The clock is the latest `sync_runs` row
  with a `manual` trigger; scheduled runs do not start it. A press inside the
  window gets 429 and "Synced 2 min ago, next available in 3 min", shown in the
  toast as a wait, not a failure.
- **Two presses at once cannot both pass.** The check and the sync share one
  transaction holding a per-tenant advisory lock
  (`pg_try_advisory_xact_lock`); the second is told a sync is running.

Tests: `packages/jobs/test/manual-sync.test.ts` (database: throttle, lock,
tenant scope, scheduled runs ignored) and `apps/web/test/sync-route.test.ts`
(every role admitted, tenant from the session, 429s).

## §12 — a lime "Sync now", and a cleaner collapsed rail (25 September 2026)

**"Sync now" is lime** (`--color-sync`, `#B8F23A`), with ink type, a 2px ink
border and a 2px solid offset shadow that closes when pressed. It is the only
control that acts on the data rather than the view, and the only place the
token is used. Ink on lime is 13.6:1. Its hue is 79° against 152–155° for
`--color-up*`, ΔE 55–72, so it does not read as "improving". The lime is 1.33:1
on white, which is why the border is part of the design rather than
decoration. This is a deliberate exception to "controls are chrome ink".

**The collapsed rail.** The Zeeraa mark crops to the ring's own square with
even padding (`RING` in `ZeeraaMark.tsx`) instead of the leading 28% of the
lockup, which cut the ring. The tenant is a square mark stored on the tenant
row (`tenants.mark_data_url`, migration 0038, written by
`set-tenant-logo.ts --mark`), or with none a monogram in the rail's own
materials with the tenant's accent as a 2px rule at its foot. The
accent-filled square read as a sticker. Each platform has its own line icon,
with its initial for one that has none, and every collapsed item has a
tooltip with its page name, on hover and on keyboard focus.

## §12 — platforms being connected show as "Integrating" (25 September 2026)

**Reverses, for this one case,** two rules: a client is never shown a control
with nothing behind it (24 September), and the rail lists only platforms that
report ("a rail advertising Microsoft Ads to a client who has never connected
it is a promise the product has not made"). On the client's instruction,
platforms being connected are listed, and say that they are being connected.

- **Which platforms** is the `integrating_platforms` config row (Spartan:
  LinkedIn Ads, Semrush, Microsoft Ads), loaded with `load-config-row.ts`.
  **What each will show** is the platform's, `INTEGRATION_PREVIEWS` in core.
- **On the rail**, after the live platforms, each with its own icon and an
  "Integrating" pill; collapsed, a dot on the icon and the tooltip "LinkedIn
  Ads, integrating". The dot breathes slowly (`@keyframes integrating`), only
  under `motion-safe:`, and not at all with reduced motion on. It is neutral,
  because green and red never mark a status, amber means Not measured and gold
  is the active item.
- **The page** at the platform's ordinary URL gives the name, "Integration in
  progress" and one line on what it will show. No figure, no chart and no
  zero.
- **The switch is automatic.** `stillIntegrating` removes a platform once
  `reportingPlatforms` includes it, which means a connection *that has
  reported data*. A connection row alone is not enough: an empty connection
  would otherwise turn a holding page into a page of zeros. LinkedIn Ads and
  Microsoft Ads are already ad platforms (`AD_PLATFORMS`), so their first
  synced day turns the item into the ordinary page. **Semrush has no page type
  yet.** It is neither an ad nor an organic platform, so it stays integrating
  until its connector exists and registers what kind of page it gets.

## §8 — UW approved and Offer are one step (25 September 2026)

On the client's instruction, Offer is no longer a funnel stage anywhere
(funnel, Executive, Efficiency, Breakdown, CSV): each of those reads
`funnel_stages`, and the row is gone. A deal is approved at its approval or its
offer, whichever came first.

- **How.** The `stage_merges` config row (`{ merges: [{ into: 'uw_approved',
  from: ['offer'] }] }`). After every Salesforce sync, `applyStageMerges`
  deletes every derived event and derives them again. Wherever a deal's
  earliest offer is earlier than its earliest approval, or it has no approval,
  it writes an approval at the offer's time with `stage_events.derived_from =
  'offer'` (migration 0039). A later offer on an approved deal is the same
  step, not a second approval. Merges run before the exclusions, so a
  renewal's derived approval is excluded like any other. Offer events are still
  read and stored as `offer`, because that is what Salesforce records.
- **Reconciliation.** A deal approved only at its offer is `explained`
  ("approved at their offer (stage merge)"), not drift. The offer check still
  runs against the raw field.
- **Baseline.** June–August approvals changed, so they were restated with this
  as the reason: the ramp's approvals and CPA for June (1 → 4, $12,812.53 →
  $3,203.13) and July (20 → 23, $1,453.87 → $1,264.23), and 24 channel-figure
  versions. Each frozen `stage:offer` figure is retired with a next version
  holding no value and `Retired: <reason>`
  (`freeze-baseline --correct-channel-figures --retire-missing`). The number
  check accepts exactly that, and fails if a retired figure is ever computed
  again.
- **Production, approvals before → after, last touch:** June 4 → 10 (Google
  Ads 1 → 4, Meta 2 → 4, Direct & other 0 → 1), July 40 → 43 (Google Ads
  20 → 23), August 29 → 31 (Direct & other 13 → 15), September 53 → 54
  (Google Ads 25 → 26).

## §11 — user activity and the account audit log on People (25 September 2026)

People (Zeeraa admins only) now shows, per person in the current tenant, an
"Online now" badge (a page opened in the last five minutes), last seen, last
sign-in and the last page viewed, and below the forms an audit log of account
actions: account created, password reset, access granted, access removed, and
every sign-in — who, to whom, when. Migration 0040.

- **Activity is recorded cheaply.** `ActivityBeacon` in the tenant layout calls
  a server action when the pathname changes, and never on `AutoRefresh`'s
  re-render, so an unattended tab does not read as a person online. At most
  once a minute per person and tenant: the beacon holds a later page until the
  minute is up, and the upsert's `WHERE last_seen_at < now() - 1 minute`
  refuses anything sooner across tabs and instances. Each write follows a page
  view that already woke the database. The cost is that the last page can lag
  by up to a minute, and a person reading one page for over five minutes reads
  as not online.
- **The audit log is append-only for every role**, on the `baseline_snapshots`
  pattern: `zeeraa_app` holds SELECT and INSERT only, and a trigger refuses
  UPDATE, DELETE and TRUNCATE even to a connection that bypasses row level
  security. The only deletion is the tenant's own, told apart through
  `app.tenant_index`. No foreign key to `users` — the record outlives the
  account, so the addresses are copied onto the row.
- **An account action is written in the transaction that performs it**, so an
  entry and its change cannot disagree, and `tenant_admin_write` requires
  `actor_user_id = app.current_user_id()` — an entry cannot name somebody else
  as its author.
- **A sign-in is one row per tenant the person holds**, written as themselves
  under `withUserOnly` (`own_sign_in`: their own row, in a tenant
  `app.is_member_of`). Recorded before the session is created, so a sign-in
  the log could not record does not happen. A sign-in by an account with no
  membership is not recorded; it reaches `/no-access` only. Last sign-in on the
  roster is the newest of these rows, so it is blank for everybody until they
  next sign in after the deploy.
- **The CLAUDE.md policy set is narrowed on both tables.** `tenant_isolation`
  admits `zeeraa_admin` rather than every member, because this is Zeeraa's
  record, not the client's. `user_activity` has no `tenant_admin_write`:
  nobody writes somebody else's activity, a Zeeraa admin included;
  `own_activity` is the only writer.
- **Not recorded:** failed sign-ins, a person changing their own password, and
  anything before 25 September 2026. An empty cell is an em dash, never
  "Never".

Tests: `packages/db/test/audit-and-activity.test.ts` (policies, the trigger
against a superuser, the tenant-deletion cascade) and
`apps/web/test/activity-and-audit.test.ts` (each account action and the
sign-in write their row; the beacon keys on the pathname alone; formatting in
the tenant's timezone). Eight mutations in `mutation-test.ts`.

## §7 — a funded-deals list on the Google Ads and Meta pages (25 September 2026)

Below "Cost per funded deal" and "By campaign", each of the two pages lists
the deals behind its funded count: deal name, funded date, funded amount,
campaign, and keyword (Google Ads) or ad (Meta). Nothing else on the page
changed.

- **It is the count, row for row.** `platformOutcomes` builds the list from
  the same set of opportunities it counts (`here`), under the page's range and
  attribution model, so the list cannot disagree with the figure.
  `consistency.numbers.ts` checks it on every deploy against production, for
  both platforms, three ranges and both models.
- **Every cell has a recorded source or reads "Not recorded"** (`lib/funded-deals.ts`):
  the deal's name is Salesforce's `Opportunity.Name` (new, 0041; the sync reads
  it and `backfill-opportunity-names.ts` filled the deals already stored); the
  date is the deal's first value-stage event in the range; the amount is
  `funded_amount`; the campaign is the one attribution credits, exactly as
  "By campaign" reads it — so a Meta deal never has one, and the page already
  says why. The campaign is not recovered from a UTM, which would be a second
  attribution rule.
- **The keyword or ad comes from the deal's own lead's landing URL**, and only
  where that lead's source (`leads.channel`, decided at ingest) is this
  platform. Which parameter carries it is the `landing_url_parameters` config
  row, not code: for Spartan, Google's `utm_term` is ValueTrack {keyword} and
  Meta's `utm_content` is {{ad.id}} — confirmed by asking Meta, which returned
  an `adset_id` for that id and none for the `utm_term` one (the ad set).
- **A Meta ad is shown by name** where the Meta sync has read it: it asks the
  ad account's own `/ads` edge for the ids its leads carry (`fetchAdNames`;
  the `?ids=` read was withdrawn in v26), which answers only for ads in that
  account, and stores them in `platform_ads` (0041). An id with no name yet is
  shown as the id the lead recorded.
