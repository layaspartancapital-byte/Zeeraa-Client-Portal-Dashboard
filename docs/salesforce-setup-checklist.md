# Salesforce setup checklist

A working list for one pass through Setup. Every API name below is written with
the **exact casing the org already uses**, verified against a describe call on
17 September 2026. Casing is load-bearing — see the note at the bottom.

Nothing here is destructive. Every item creates a field, a mapping or a
permission; none of it modifies or deletes a record.

---

## 1. Opportunity click-ID fields — blocking attribution

The Opportunity object currently has **no** click-ID, UTM or landing-page field
of any kind. Its only source columns are `LeadSource` and
`Opportunity_Source__c`, both picklists. Until these exist and are mapped, every
opportunity is unattributable and cost per funded deal cannot be computed for
paid channels.

Create each field on **Opportunity** with the API name, type and length matching
the Lead side exactly. Lead field mapping refuses to map fields whose type or
length differ, and does so quietly.

Setup → Object Manager → **Opportunity** → Fields & Relationships → New → Text.

| # | API name on Opportunity | Type | Length | Matches Lead field | Lead populated |
| --- | --- | --- | --- | --- | --- |
| ☐ 1 | `gclid__c` | Text | 255 | `gclid__c` | 33.6% |
| ☐ 2 | `acq_fbclid__c` | Text | 255 | `acq_fbclid__c` | 13.4% |
| ☐ 3 | `Gbraid__c` | Text | 255 | `Gbraid__c` | 0% |
| ☐ 4 | `Wbraid__c` | Text | 255 | `Wbraid__c` | 0% |
| ☐ 5 | `Li_Fat_ID__c` | Text | 255 | `Li_Fat_ID__c` | 0% |
| ☐ 6 | `msclkid__c` | Text | 255 | **does not exist — see §2** | — |

Items 3–5 are populated on no lead today. Create them anyway: they cost nothing,
and the alternative is a second trip through Setup at the moment the forms start
capturing them, with every conversion in between permanently unattributed.

> **Lowercase is deliberate on `gclid__c` and `acq_fbclid__c`.** Setup derives the
> API name from what you type in the **Field Name** box and preserves its case.
> Type `gclid`, not `GCLID`. The connector reads the REST response by exact key,
> so `GCLID__c` would parse, validate and read `undefined` on every record.

---

## 2. `msclkid` — absent on both objects

Microsoft Ads is in the engagement and there is **no** `msclkid` field anywhere
in the org — not on Lead, not on Opportunity. Every Microsoft Ads click is
currently unattributable at the CRM, and no amount of mapping fixes it.

| # | Object | API name | Type | Length |
| --- | --- | --- | --- | --- |
| ☐ 7 | Lead | `msclkid__c` | Text | 255 |
| ☐ 8 | Opportunity | `msclkid__c` | Text | 255 |

`msclkid` is 32 hex characters, but use 255 to match every other click-ID field
in the org — a length mismatch between the two objects blocks the mapping.

---

## 3. Map the Lead fields to the Opportunity fields

**Creating the field is not the same as mapping it.** This is a separate screen,
and a field that exists on both objects but is not mapped stays null forever,
looking exactly like a field that was never created.

Setup → Object Manager → **Lead** → Fields & Relationships → **Map Lead Fields**
→ Opportunity tab.

| # | Map Lead field | To Opportunity field |
| --- | --- | --- |
| ☐ 9 | `gclid__c` | `gclid__c` |
| ☐ 10 | `acq_fbclid__c` | `acq_fbclid__c` |
| ☐ 11 | `Gbraid__c` | `Gbraid__c` |
| ☐ 12 | `Wbraid__c` | `Wbraid__c` |
| ☐ 13 | `Li_Fat_ID__c` | `Li_Fat_ID__c` |
| ☐ 14 | `msclkid__c` | `msclkid__c` |

Mapping is **not retrospective**: it copies the value at the moment of
conversion, so every opportunity that converted before today keeps a null. That
history is recoverable — see §6.

---

## 4. Field-level security for the integration user

The single most confusing failure mode here. Without **Read** on every field
above, the REST API omits it from the response entirely, which is
indistinguishable from the field not existing — and everything looks correct in
the Setup UI.

- ☐ 15 The integration user's profile or permission set has **Read** on every
  field in §1 and §2, on **both** Lead and Opportunity.
- ☐ 16 Same for the fields the lead sync already reads:
  `csbs__Estimated_Monthly_Revenue__c`, `AnnualRevenue`,
  `Time_in_Business_Months__c`, `utm_source__c`, `utm_medium__c`,
  `utm_campaign__c`, `utm_content__c`, `utm_term__c`, `pi__url__c`, `Industry`,
  `State`.

---

## 5. Stage timestamps

- ☐ 17 **`csbs__Approved_Date_Time__c` is empty on all 712 opportunities.** The
  UW-approved stage has no source, so the conversion rate into and out of it
  reads zero for every period. Decide which: the stage starts being stamped, or
  it comes out of the configured funnel and SQL → Offer becomes the measured
  transition. For contrast, `csbs__Declined_Date_Time__c` is populated on 487 and
  25 opportunities are won, so approvals are happening and are simply not
  stamped.

- ☐ 18 **`Loss_Reason__c` stopped being filled in.** Every recorded reason
  predates February 2026; the last 180 days hold 0 of 414. Not a field to
  create — a process to restart, or a slice to leave cut.

No action needed on these, which are confirmed working:
`csbs__Underwriting_Date_Time__c` (62.1%), `csbs__Application_In_Date_Time__c`
(65.3%), `csbs__Declined_Date_Time__c` (68.4%), and Opportunity `StageName`
field history (1,294 transitions retained from 2026-03-20).

---

## 6. After the fields exist

- ☐ 19 Tell me, and I run `validateMapping` against the org **before** anything
  is built on the new fields. It checks every mapped field against a describe
  and reports the ones the integration user cannot see, so a permissions gap
  surfaces as a named dependency rather than as a column of nulls.
- ☐ 20 Then the backfill. Every converted Lead still holds its click ID and
  still points at the opportunity it became through `ConvertedOpportunityId`, so
  the history is reconstructable — 244 converted leads carry a `gclid__c` today.
  Worth running before the first report: without it the baseline period has no
  attribution and every trend starts from an artificial step change on the day
  the mapping went in.

---

## Not admin work — the web forms

These need no field created. The fields already exist and nothing writes to
them, so this is a form-capture change rather than a Setup change.

- ☐ 21 **A monthly-revenue question**, posting into
  `csbs__Estimated_Monthly_Revenue__c` (8.8% of inbound leads today). Unblocks
  the MQL stage and the revenue-band slice.
- ☐ 22 **A time-in-business question**, posting into `Time_in_Business_Months__c`
  (**0.4%**). This is the binding constraint on MQL — among the 652 leads that
  converted, two carry a value.
- ☐ 23 **Capture `gbraid` and `wbraid`** into `Gbraid__c` and `Wbraid__c`. Google
  sets these *instead of* `gclid` on iOS app-to-web and web-to-app journeys, so
  a slice of Google clicks arrives with no click ID at all today.
- ☐ 24 **Capture `msclkid`** once §2 exists.

### Duplicate fields worth resolving while you are in there

Four platforms have two click-ID fields each, all of them empty. Pick one per
platform and delete or ignore the other before the forms start writing, or the
next probe has to guess which is canonical.

| Platform | Field A | Field B |
| --- | --- | --- |
| Pinterest | `Epik__c` (labelled "Pinterest Click ID") | `Pinterest_Click_ID__c` |
| TikTok | `TTCLID__c` | `TikTok_Click_ID__c` |
| Twitter/X | `Twclid__c` | `Twitter_Click_ID__c` |
| Snapchat | `ScCid__c` | `Snapchat_Click_ID__c` |

None of these platforms is in the current engagement, so this is housekeeping
rather than a blocker.

---

## Why casing matters

Salesforce treats API names case-insensitively in SOQL and in Setup, so
`GCLID__c` and `gclid__c` look interchangeable and both queries succeed. They
are not interchangeable to the connector: `normalizeLead` reads `record[field]`
off the REST response, which is a case-sensitive property lookup, and the
response uses the field's canonical API name.

The mapping in this repository said `GCLID__c` until 17 September 2026. It
validated cleanly — `validateMapping` compares case-insensitively, by design,
because Setup does — and would have read `undefined` on every record, attributing
nothing, silently. Whatever casing the new Opportunity fields get, the config row
has to match it exactly.
