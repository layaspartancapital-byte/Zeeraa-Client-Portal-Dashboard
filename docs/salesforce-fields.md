# Salesforce fields required for attribution

What the client's Salesforce admin needs to create, and why each one.

> For the tick-list version to work from in Setup, with exact casing and no
> reasoning in the way, see **`docs/salesforce-setup-checklist.md`**. This
> document is the why; that one is the what. Written
against Spartan's org; the connector reads these names from
`connections.config.fieldMapping`, so a different org can use different names
without a code change.

---

## 1. Click-ID fields

Create each field **twice** — once on Lead, once on Opportunity — with the
**same API name, type and length on both sides**. Lead field mapping refuses to
map fields whose type or length differ, and does so quietly.

### Minimum, for the paid channels in the engagement

| Platform | URL parameter | API name | Type | Status |
| --- | --- | --- | --- | --- |
| Google Ads | `gclid` | `gclid__c` | Text(255) | exists on Lead (lowercase — see below); **needed on Opportunity** |
| Microsoft Ads | `msclkid` | `MSCLKID__c` | Text(255) | **needed on both** |
| Meta | `fbclid` | `FBCLID__c` | Text(255) | **needed on both** |
| LinkedIn Ads | `li_fat_id` | `LI_FAT_ID__c` | Text(255) | **needed on both** |

### Recommended, and cheap to add now

| Platform | URL parameter | API name | Type | Why |
| --- | --- | --- | --- | --- |
| Google Ads | `gbraid` | `GBRAID__c` | Text(255) | set instead of `gclid` on iOS app-to-web journeys |
| Google Ads | `wbraid` | `WBRAID__c` | Text(255) | set instead of `gclid` on web-to-app journeys |

`gbraid` and `wbraid` are not alternatives to `gclid` that you can skip — Google
sets them *in place of* `gclid` when iOS privacy rules prevent the standard
parameter. Omitting them means a slice of Google clicks arrives with no click ID
at all and is silently unattributable. Adding them later is possible; recovering
the clicks that arrived in the meantime is not.

**Length.** Text(255) for all of them. `msclkid` is 32 hex characters and
`fbclid` is typically under 100, but `gclid` regularly exceeds 100 and is not
documented as bounded. 255 costs nothing and removes a truncation failure that
would corrupt the join rather than break it.

### Three things that will silently defeat this

1. **Creating the Opportunity field is not the same as mapping it.** The mapping
   is a separate screen: Setup → Object Manager → **Lead** → Fields &
   Relationships → **Map Lead Fields** → Opportunity tab. A field that exists on
   both objects but is not mapped stays null forever, and looks exactly like a
   field that was never created.

2. **Field-level security.** The integration user's profile or permission set
   needs **Read** on every one of these fields on both objects. Without it the
   REST API omits the field from the response entirely — indistinguishable from
   the field not existing. This is the single most confusing failure mode here,
   because everything looks right in the Setup UI.

3. **Mapping is not retrospective.** Lead field mapping copies the value at the
   moment of conversion. Every opportunity that converted before the mapping
   exists keeps a null, permanently, unless it is backfilled.

4. **Casing.** Salesforce treats API names case-insensitively in SOQL and in
   Setup, so `GCLID__c` and `gclid__c` look interchangeable and both queries
   succeed. They are not interchangeable to the connector: `normalizeLead` reads
   `record[field]` off the REST response, a case-sensitive property lookup, and
   the response uses the field's canonical casing. The existing Lead field in
   this org is lowercase **`gclid__c`**, and the mapping said `GCLID__c` — which
   validated cleanly (`validateMapping` compares case-insensitively, by design,
   because Setup does) and would have read `undefined` on every record. Fixed in
   the seed on 17 September 2026. Whatever casing the new Opportunity fields get,
   the mapping has to match it exactly.

### Backfilling the history

The historical values are not lost. Every converted Lead still holds its click
ID and still points at the opportunity it became, via `ConvertedOpportunityId`.
So the past can be reconstructed:

```sql
SELECT Id, ConvertedOpportunityId, GCLID__c, MSCLKID__c
FROM Lead
WHERE IsConverted = true AND ConvertedOpportunityId != null
```

Each row is an Opportunity id and the click ID that belongs on it. This is a
one-off write, and it is worth doing before the first report — without it the
baseline period has no attribution and every trend starts from an artificial
step change on the day the mapping went in.

Tell me when the fields exist and I will run `validateMapping` first, then
produce the backfill file or run it through the connector.

### A note for later, not a reason to change course

That same `ConvertedOpportunityId` link means attribution *could* be derived
without the Opportunity fields at all. It is a weaker design — it only covers
opportunities that came from a lead conversion, and nothing else — so the field
mapping remains the right primary path. It is worth keeping in mind as an
independent cross-check once the mapping is live: if the two disagree, the
mapping has a gap.

---

## 2. Fields the lead sync reads

These are not blocking — the connector validates them at sync time and reports
any that are missing as a connection dependency rather than writing nulls. But
confirming them now avoids a second round trip.

The probe inventories these rather than assuming them, and it was run against
the production org on **17 September 2026**. What follows is the result, not an
illustration.

### Scope: inbound leads only

Every rate below is within the **inbound** population — 7,196 leads — defined by
`tenant_config.lead_exclusion`. Cold-outreach records are excluded at the SOQL
query and never ingested; see `docs/brief-amendments.md` §6 for the rules and
the reasoning. Org-wide rates are not quoted anywhere here, because the object
holds two populations that do not mix and an average of them describes neither.

Running the probe scoped:

```bash
LEAD_EXCLUSION_JSON=$PWD/packages/db/seeds/lead-exclusion.spartan.json \
  pnpm --filter @zeeraa/connectors probe
```

It prints the classification before the inventory:

```
Lead scope

  considered        53908
    · cold_outreach_owner        46580 (86.4%)  Owned by the cold-outreach holding queue
    · bulk_load_2026_09_08       46580 (86.4%)  Cold-list bulk load of 8 September 2026, with no lead source
  excluded          46580 (86.4%)
    rules overlap, so the per-rule figures above do not sum to this.
  unclassified        132 (0.2%)  excluded, and counted
  inbound            7196 (13.3%)  ← every rate below is within this
```

Without `LEAD_EXCLUSION_JSON` the probe runs unscoped and says so, loudly. The
canonical copy of the rules is the `lead_exclusion` config row; the JSON file is
what seeds it.

### The inventory

| Concept | Field | Type | Inbound | Verdict |
| --- | --- | --- | --- | --- |
| monthly revenue | `csbs__Estimated_Monthly_Revenue__c` | currency | **8.8%** (635) | ⚠️ under 50% — cut |
| | `Monthly_Avg_Credit_Card_Volume__c` | currency | 0.0% (1) | ⚠️ empty |
| | `Average_Monthly_Bank_Deposits__c` | currency | 0.0% (0) | ⚠️ empty |
| annual revenue | `AnnualRevenue` (standard) | currency | **6.7%** (482) | ⚠️ under 50% — cut |
| time in business | `Time_in_Business_Months__c` | double | **0.4%** (32) | ⚠️ under 50% — cut, and invalid |
| | `csbs__Business_Start_Date_Current_Ownership__c` | date | 0.0% (0) | ⚠️ empty |
| industry | `Industry` (standard) | picklist | **34.5%** (2,482) | ⚠️ under 50% — keep with share |
| | `Business_Type__c` | picklist | 0.4% (29) | ⚠️ empty |
| | `NAICS_Code_Text__c` | string | 0.0% (1) | ⚠️ empty |
| | `csbs__Application_Industry__c` | string | 0.0% (0) | ⚠️ empty |
| state | `State` (standard) | string | **29.3%** (2,111) | ⚠️ under 50% — keep with share |
| | `State_Owner1__c` | string | 19.9% (1,435) | ⚠️ a principal's state, not the business's |
| | `csbs__State_of_Incorporation__c` | picklist | 0.0% (0) | ⚠️ empty |
| utm source | `LeadSource` (standard) | picklist | **94.2%** (6,778) | ✅ keep — coarse, best covered |
| | `utm_source__c` | string | **58.4%** (4,200) | ✅ keep — the precise one |
| | `csbs__UTM_Source__c`, `pi__utm_source__c` | string | 0.0% (0) | ⚠️ empty |
| utm medium | `utm_medium__c` | string | **49.1%** (3,533) | ⚠️ under 50% by a whisker — keep with share |
| | `csbs__UTM_Medium__c`, `pi__utm_medium__c` | string | 0.0% (0) | ⚠️ empty |
| utm campaign | `utm_campaign__c` | string | **59.2%** (4,261) | ✅ keep |
| | `UTM_Campaign_ID__c` | string | 8.8% (634) | ⚠️ sparse |
| | `csbs__UTM_Campaign__c` | string | 8.4% (607) | ⚠️ sparse |
| utm content | `utm_content__c` | string | **46.4%** (3,341) | ⚠️ under 50% — keep with share |
| utm term | `utm_term__c` | string | **46.1%** (3,319) | ⚠️ under 50% — keep with share |
| landing page | `pi__url__c` | url | **79.6%** (5,730) | ✅ **keep — the pick** |
| | `referral_url__c` | string | 52.4% (3,770) | ✅ usable alternative |
| | `Referrer_Source__c` | string | 46.8% (3,365) | ⚠️ under 50% |
| | `Landing_Page_Variant__c` | string | 34.1% (2,452) | ⚠️ an A/B label, not a page |
| | `Web_Capture_URL__c` | string | 4.0% (285) | ⚠️ near-empty |
| | `Consent_Source_URL__c` | url | 0.0% (0) | ⚠️ empty |
| | `pi__first_touch_url__c` | textarea | 0 of 2,000 sampled | ⚠️ empty |

Click IDs, for completeness — read by the attribution path rather than the lead
sync, and not covered by the inventory:

| Field | Inbound | Converted leads |
| --- | --- | --- |
| `gclid__c` | **33.6%** | **37.4%** (244 of 652) |
| `acq_fbclid__c` | 13.4% | — |
| `Epik__c`, `Gbraid__c`, `Li_Fat_ID__c`, `ScCid__c`, `TTCLID__c`, `Twclid__c`, `Wbraid__c`, `TikTok_Click_ID__c`, `Twitter_Click_ID__c`, `Pinterest_Click_ID__c`, `Snapchat_Click_ID__c` | **0.0% (0)** | 0 |

Eleven click-ID fields exist on Lead and have never held a value. They are
present, not missing — a different problem from the Opportunity side, and one
the forms have to fix rather than the admin.

### The landing-page patterns were wrong, and are fixed

The first run recommended `Landing_Page_Variant__c`, whose sampled values are
`"lp1"` — an A/B variant label, not a page — while missing `referral_url__c`,
`Referrer_Source__c` and `pi__url__c`, the last of which is the best-covered
field in the whole inventory. The concept's patterns looked only for `landing`,
`entry`, `page.?url` and `first.?page`.

`referr`, `referral` and a bare `url` have been added. A bare `url` is
deliberately broad — the module's own standard is that a false candidate costs
one row in a report a human reads while a missed one costs a silently absent
slice — with `PhotoUrl` excluded by name, since it is a URL on every Lead and
has nothing to do with a landing page.

`pi__url__c` is now the recommendation and is wired as `lead.landingPage`.

### Industry and state

Both matter more than their rates suggest — approval rates vary sharply by each,
and that variance is the engagement's central diagnosis. Both are kept, below
the 50% bar, with the unpopulated share shown beside them rather than
renormalised away.

`State_Owner1__c` is a trap worth naming: it is a principal's home state, not
the business's, and the two are not interchangeable for an approval-rate slice.

---

## 3. Stage timestamps — confirmed, using the explicit datetime fields

Field history is not being used. The mapping below is what the connector writes
into `stage_events`.

| Funnel stage | Source | Populated (of 712 opportunities) |
| --- | --- | --- |
| Lead | `CreatedDate` (standard) | 100% |
| MQL | computed from the qualification bar at lead creation | **~0% computable** — see below |
| SQL | `csbs__Underwriting_Date_Time__c` — submission to underwriting | 62.1% (442) |
| UW approved | `csbs__Approved_Date_Time__c` | **0.0% (0)** |
| Offer | `Offer_Received_Date_Time__c` | 9.7% (69) |
| Funded | `csbs__Funded_Date_Time__c` | 2.9% (21) |

Non-stage timestamps, for reference:

| Field | Populated |
| --- | --- |
| `csbs__Application_In_Date_Time__c` | 65.3% (465) |
| `csbs__Declined_Date_Time__c` | 68.4% (487) |
| `Contract_Requested_Date_Time__c` | 3.7% (26) |
| `csbs__Contracts_In_Date_Time__c` | 2.5% (18) |
| `csbs__Closed_Lost_Date_Time__c` | 4.8% (34) |
| `csbs__Contracts_Out_Date_Time__c` | **0.0% (0)** |
| `csbs__Application_Out_Date_Time__c` | **0.0% (0)** |

### `csbs__Approved_Date_Time__c` is empty on every opportunity

The UW-approved stage has no source. The field exists, it is the obvious name,
and it has never been written — 0 of 712. Meanwhile 487 opportunities carry
`csbs__Declined_Date_Time__c` and only 25 are won, so approvals are happening and
are simply not being stamped. The funnel therefore has a hole between SQL (442)
and Offer (69), and `stage_conversion_rate('sql', 'uw_approved')` would return 0
for every period.

This needs the admin: either the stage is stamped going forward, or the UW-approved
step comes out of `funnel_stages` and SQL → Offer becomes the measured transition.
It is a configuration row either way, not a code change. Until it is resolved the
stage renders as a blocked dependency (§9.5) rather than as a zero.


### MQL is computed, not observed

There is no MQL timestamp in the org, and there does not need to be. MQL is
Spartan's marketing-qualification bar, and both of its conditions are lead
attributes known at creation:

- time in business ≥ 12 months, **and**
- revenue ≥ $10,000 monthly gross — equivalently ≥ $120,000 annual gross

So a qualifying lead reached MQL when it was created. The stage is written with
`origin = 'computed'` and marked as such everywhere it renders, so it can never
be presented as something the CRM recorded.

The two revenue figures are **one threshold at two periods**, not two tests.
Records may carry a monthly figure, an annual figure, or both, so everything is
normalised to a monthly basis before comparison: an annual-only figure is
divided by twelve, and where both are present the monthly one wins. A record
whose two figures disagree by more than the configured tolerance is flagged
rather than silently reconciled — that is nearly always a monthly figure typed
into the annual field, and it is correctable.

The bar lives in `tenant_config.mql_bar`: minimum months in business, minimum
monthly revenue, and the disagreement tolerance. Which Salesforce fields carry
each lives in `connections.config.fieldMapping.lead`, with the rest of the field
mapping — the thresholds are a fact about Spartan's business and the field names
are a fact about their Salesforce org, and the two move independently.

### SQL is submission to underwriting — checked, and confirmed

`csbs__Underwriting_Date_Time__c`. Submission to underwriting is the
sales-qualification event at Spartan, which also matches the proposal's
definition of the SQL stage as submissions carrying duplicate and resubmission
rates.

The concern was that a queue might sit between submission
(`csbs__Application_In_Date_Time__c`) and underwriting pickup, in which case
using the underwriting stamp would overstate Lead → SQL velocity by the length
of the queue. Measured over the 405 opportunities carrying both fields:

| | |
| --- | --- |
| Median gap | **0.0 hours** |
| 90th percentile gap | **0.2 hours** |
| Same day | **98.3%** (398 of 405) |

The agreed rule was: 90% or more same-day, stay with the underwriting field.
98.3% clears it comfortably, and a 0.2-hour 90th percentile means there is no
queue to speak of — the two stamps are effectively the same event. **Staying with
`csbs__Underwriting_Date_Time__c`.** No queue length to report.

### Two fields that are not funnel stages

| Field | Stored as | Used for |
| --- | --- | --- |
| `csbs__Declined_Date_Time__c` | `declined` event | time-to-decline; pairs with the decline reason |
| `Contract_Requested_Date_Time__c` | `contract_requested` event | sits between Offer and Funded |

Both are written to `stage_events` even though neither is a configured funnel
stage. They cost nothing to store, they are not rendered in the stage flow, and
`contract_requested` in particular looks like a stage worth adding once there is
data to show whether deals stall there.

---

## 4. Decline reason

The probe reports `Loss_Reason__c` populated on **16.4%** of a 500-record sample
of closed-lost opportunities (20.4% over all 525). That figure is real and it is
also the wrong summary, because the coverage is not spread across time — it
stopped.

| Close month | Closed-lost | Reason recorded |
| --- | --- | --- |
| 2023-07 → 2024-09 | 17 | 100% |
| 2024-12 | 23 | 100% |
| 2025-01 | 68 | 100% |
| 2026-02 | 1 | 0% |
| 2026-03 | 3 | 0% |
| 2026-04 | 27 | 0% |
| 2026-05 | 57 | 0% |
| 2026-06 | 16 | 0% |
| 2026-07 | 133 | 0% |
| 2026-08 | 126 | 0% |
| 2026-09 | 54 | 0% |

**Every one of the 107 recorded reasons predates February 2026. Coverage in the
last 180 days is 0 of 414.** Whatever process filled this field in was abandoned
some time after January 2025.

So the honest reading is not "16.4% coverage, render with the gap shown". It is
"the field is no longer maintained". A breakdown built on it would describe
Spartan's 2024 loss mix and label it current.

**Cut.** The decline-reason breakdown is a `blocked_dependencies` row
(`decline_reason_breakdown`, subject `breakdown` / `decline_reason`) rather than
a rendered chart, so the funnel view explains the absence and names the date
coverage stopped. Deleting the row is what restores the slice.

The recorded values, for whoever decides whether to restart the process:

| Reason | Count |
| --- | --- |
| Insufficient Revenue | 41 |
| Ineligibility Due to Legal or Regulatory Issues | 13 |
| Unacceptable Bank Statements | 9 |
| Poor Credit History | 9 |
| Inability to Meet Minimum Requirements | 7 |
| Lost to Competitor | 6 |
| Negative Business Performance Trends | 5 |
| Fraud Concerns | 4 |
| Price | 3 |
| No Decision / Non-Responsive | 3 |
| No Budget / Lost Funding | 2 |
| Other | 2 |
| Client Changed Mind, High Existing Debt, Failure to Provide Documentation | 1 each |
| **(not recorded)** | **418** |

### The mapping points at a field that does not exist

`connections.config.fieldMapping.opportunity.declineReason` is set to
`csbs__Decline_Reason__c`. **There is no such field in the org.**
`validateMapping` returns `ok: false` on it today — it is the only issue it
reports, and it is non-blocking by the current severity rule, so the sync would
run and write nulls into `decline_reason` forever.

The real picklist is `Loss_Reason__c`. It has been left unchanged in the seed
rather than repointed, because repointing it at a field that is 0% populated
since February 2026 swaps a visible failure for an invisible one. The decision
belongs with the decline-reason question above: restart the process and repoint,
or drop `declineReason` from the mapping and cut the slice.

Other candidates, none of them usable: `Competitor_Lost_To__c` (0 of 712),
`Do_Not_Call_Reason__c` (0), `Business_Health_Status__c` (0). The one
well-covered decline signal in the org is `csbs__Declined_Date_Time__c` at 68.4%
— which gives *when* a deal was declined, and never *why*.

---

## 5. Fields that are absent rather than empty

Worth doing in the same pass as the click-ID fields, since it is the same trip
into Setup. "Absent" means no field in the org carries the concept at all;
"empty" means the field exists and nobody writes to it, which is a forms or
process problem rather than an admin one.

### Absent — needs creating

| Object | Field | Why |
| --- | --- | --- |
| Opportunity | every click-ID field | the whole attribution join; `gclid__c`, `msclkid`, `fbclid`, `li_fat_id`, `gbraid`, `wbraid` — see §1. The Opportunity object has **no** click, UTM or landing-page field of any kind; its only source columns are `LeadSource` and `Opportunity_Source__c`, both picklists |
| Opportunity | a UW-approved timestamp that is actually stamped | `csbs__Approved_Date_Time__c` exists but is 0 of 712. This may be process rather than a missing field — confirm which before creating anything |
| Lead | a monthly-revenue question on the web forms | `csbs__Estimated_Monthly_Revenue__c` **already exists**; nothing to create, the forms need to post to it |
| Lead | a time-in-business question on the web forms | `Time_in_Business_Months__c` **already exists**; same |

Note the shape of that list: **almost nothing needs creating on Lead.** Every
concept in the inventory has at least one field already present. The gap is that
the forms do not fill them.

### Present but never written — a forms problem, not an admin one

Creating more fields will not help any of these; they are already there.

- Eleven click-ID fields on Lead at exactly 0: `Epik__c`, `Gbraid__c`,
  `Li_Fat_ID__c`, `ScCid__c`, `TTCLID__c`, `Twclid__c`, `Wbraid__c`,
  `TikTok_Click_ID__c`, `Twitter_Click_ID__c`, `Pinterest_Click_ID__c`,
  `Snapchat_Click_ID__c`. `Gbraid__c` and `Wbraid__c` matter most — §1 explains
  why, and they are already created, so this is purely a form-capture fix.
- The entire `csbs__` UTM set: `csbs__UTM_Source__c`, `csbs__UTM_Medium__c`,
  `csbs__UTM_Content__c`, `csbs__UTM_Term__c` all at 0. The managed package
  ships them; nothing populates them. Use the bare `utm_*__c` fields.
- Most of the `pi__` (Account Engagement) set, except `pi__url__c` at 79.6%.
- `Average_Monthly_Bank_Deposits__c`, `csbs__Application_Industry__c`,
  `Consent_Source_URL__c`, `Competitor_Lost_To__c`, `Do_Not_Call_Reason__c`,
  `Business_Health_Status__c`, `csbs__Contracts_Out_Date_Time__c`,
  `csbs__Application_Out_Date_Time__c` — all 0.

### Present and wrong in the mapping

- `opportunity.declineReason: 'csbs__Decline_Reason__c'` — does not exist. See §4.
- `lead.clickIds.google_ads: 'GCLID__c'` — wrong casing; the org has `gclid__c`.
  **Fixed in the seed on 17 September 2026.**
- `lead.selfReportedRevenue`, `selfReportedAnnualRevenue` and
  `selfReportedTimeInBusinessMonths` were **not set at all**, so the MQL bar had
  no inputs regardless of population. Now wired to
  `csbs__Estimated_Monthly_Revenue__c`, `AnnualRevenue` and
  `Time_in_Business_Months__c`.
- `lead.industry`, `lead.state`, the five `utm*` fields and `lead.landingPage`
  were all unset. Now wired, to `Industry`, `State`, the bare `utm_*__c` fields
  and `pi__url__c` respectively.


---

## Appendix — the org enumerated, 22 September 2026

Every queryable object in Spartan's org was described (760 of them) and every
field whose API name or label mentions revenue or time in business was
collected. 77 candidates across 24 objects. This is the evidence behind the
precedence lists in `connections.config.fieldMapping`, and the command that
reproduces the coverage half of it is
`pnpm --filter @zeeraa/connectors qualification-coverage`.

### Two fields hold a vendor's codes, not quantities

`MIYB_Years_in_Business__c` and `MIRV_Volume_Code__c` carry the identical value
set — `0000`, `1000`, `1100`, `1110`, `1111` — one for each half of the bar.
Neither is a quantity. **MIYB is no longer chased for a decode key and is
dropped.** MIRV was never mapped; it is now listed as undecodable so that it
cannot be added by somebody reading its name, which was one edit away: mapped as
a monthly-revenue candidate it would have read 1,527 leads as earning
$1,000–$1,111 a month and failing the revenue bar.

The same codes leak into `Years_in_Business__c`, which is otherwise a clean
picklist — 5 records of `1111` and `1000`. A blocklist could not have caught
those, which is why the parser refuses them structurally: **a bare number in a
field whose values normally carry their own unit is unreadable, not a count of
months.** `readDurationBand` read `1000` as a thousand months and cleared a
twelve-month bar.

That guard cannot be applied to revenue. `Monthly_Revenue_Text__c` holds genuine
bare amounts — `25000`, `75000`, `200000` on 627 leads — so for revenue the
field-level exclusion is the only defence there is.

### A bare number means whatever its field means

`Years_In_Business_Text__c` holds bare `3`, `4`, `5` meaning **years**, beside
`< 12 Months` and `5+ Years` meaning what they say. Read as months, a
three-year-old business failed the twelve-month bar. Each candidate now declares
what a bare number in it means — `labelled`, `months` or `years` — and a unit
carried by the value overrules the field, because one picklist mixes both.

### The enumeration missed the best field, because it searched by name

`How_long_have_you_been_in_business__c` holds the web form's own question and
its clean bands — `Less than 6 months`, `6 - 12 months`, `1 - 3 Years`,
`3 - 5 Years`, `5+ Years` — on **1,426 of September's 1,703 inbound leads**.
The first sweep did not find it, because that sweep matched fields whose *name
or label describes the concept*: `time in business`, `years in business`,
`business start`. This field is named after the question a merchant was asked,
so no concept-shaped pattern reaches it.

**Find a field by what its values look like, not by what it is called.** The
sweep that found it selected every textual field on Lead — 288 of them — over
one month of leads and matched the *values* against the band strings. That is
the sweep to run first next time; the name-based one is a shortcut that works
until somebody names a field after a sentence.

Its population rises exactly as the older fields empty, which is why coverage
looked like it was collapsing:

| | Mar | Apr | May | Jun | Jul | Aug | Sep |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `How_long_have_you_been_in_business__c` | 2 | 13 | 261 | 652 | 737 | 627 | **1,426** |
| `MIYB_Years_in_Business__c` (codes) | 18 | 553 | 1,014 | 658 | 692 | 520 | 529 |
| `Time_in_Business__c` | 5 | — | 75 | 227 | 177 | 224 | 180 |

88% of its 3,727 populated values resolve against the bar. The 12% that do not
are almost entirely `6 - 12 months`, which spans the twelve-month bar and
resolves to neither answer — 447 leads. That band is the residue, and choosing a
side for it would be inventing the answer.

### Candidates, in precedence order

Revenue, all on Lead. Ordered by what actually answers:

| Field | Period | Answered |
| --- | --- | ---: |
| `Average_Monthly_Revenue_Text2__c` | monthly | 3,746 |
| `Average_Monthly_Revenue__c` | monthly | 1,091 |
| `Monthly_Revenue_Text__c` | monthly | 677 |
| `AnnualRevenue` | annual | 252 |
| `csbs__Estimated_Monthly_Revenue__c` | monthly | 1 |
| `Annual_Revenue_Text__c` | annual | 1 |
| `csbs__Monthly_Revenue__c`, `Monthly_Revenue__c` | monthly | 0 |

Time in business, all on Lead:

| Field | Bare number means | Answered |
| --- | --- | ---: |
| `How_long_have_you_been_in_business__c` | labelled | 3,279 |
| `Years_in_Business__c` | labelled | 1,635 |
| `Time_in_Business__c` | labelled | 822 |
| `Time_in_Business_Months__c` | months | 32 |
| `Years_In_Business_Text__c` | years | 31 |
| `Time_in_Business_SEM_Value__c` | labelled | 0 |

### What the other objects hold, and why none of it feeds the bar

| Object | Fields | Why not |
| --- | --- | --- |
| Opportunity | `csbs__Estimated_Monthly_Revenue__c` 35%, `csbs__Avg_Bank_Deposits__c` 35% | exists only for converted leads, and is captured at underwriting — judging a lead by it would qualify leads *because* they progressed |
| `csbs__Monthly_Statement_Summary__c` | `csbs__True_Revenue__c` 98% of 787 | bank-statement revenue, collected during underwriting; the same objection, more strongly |
| `csbs__Statement__c` | `csbs__Deposit_Amount__c` 100% of 887 | as above |
| Account | `AnnualRevenue` 27 of 25,372 | effectively empty |
| `csbs__Program__c`, Account `csbs__Minimum_*` | lender criteria | thresholds a lender requires, not the merchant's figures — reading them as revenue would be a category error |
| Contact | `csbs__Gross_Annual_Income__c` | a person's income, not the business's |
| Quote, Campaign, payment and signature packages | — | not the merchant's trading figures |

### Coverage, inbound leads only

With `How_long_have_you_been_in_business__c` mapped:

| Month | Leads | Revenue populated | Revenue usable | Duration populated | Duration usable | Both usable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-06 | 986 | 98.9% | 94.8% | 94.6% | 87.8% | 83.8% |
| 2026-07 | 976 | 96.6% | 92.2% | 95.7% | 85.5% | 81.0% |
| 2026-08 | 981 | 88.1% | 83.7% | 86.7% | 77.3% | 72.7% |
| 2026-09 | 1,703 | 95.2% | 93.8% | 94.3% | 81.6% | 80.2% |
| **All time** | **7,581** | **85.6%** | **76.1%** | **83.3%** | **76.5%** | **66.5%** |

Before it was mapped, duration usable read 33.8% all-time and 9.9% for
September, and the fall through the year looked like the forms giving up on the
question. They had not: the answer had moved to a field nothing read.

**Populated and usable are different questions**, and the gap is what to act on:
719 leads carry a revenue answer that resolves to nothing — mostly
`New Business`, a categorical label rather than an amount, and bands straddling
the $10,000 bar — and 517 carry a duration answer that does the same, almost all
of them `6 - 12 months` against a twelve-month bar. Reporting population alone
would have called `MIYB`'s 53% coverage.
