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
