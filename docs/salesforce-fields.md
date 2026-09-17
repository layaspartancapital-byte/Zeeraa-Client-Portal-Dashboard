# Salesforce fields required for attribution

What the client's Salesforce admin needs to create, and why each one. Written
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
| Google Ads | `gclid` | `GCLID__c` | Text(255) | exists on Lead; **needed on Opportunity** |
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

Tell me when the fields exist and I will produce the backfill file, or run it
through the connector.

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

| Purpose | Expected on Lead | Notes |
| --- | --- | --- |
| UTM source / medium / campaign / content / term | five text fields | drives the channel breakdown when a click ID is absent |
| Landing page | text or URL | |
| Self-reported monthly revenue | currency or number | feeds `qualified_rate` (minimum $10,000) |
| Self-reported time in business | number, months | feeds `qualified_rate` (minimum 12 months) |
| Industry | picklist or text | standard `Industry` if populated |
| State | picklist or text | standard `State`/`StateCode` if populated |

Industry and state matter more here than they look: approval rates vary sharply
by both, and that variance is the engagement's central diagnosis. If they are
not populated on Lead, the funnel view loses its two most useful slices.

---

## 3. Stage timestamps — confirmed, using the explicit datetime fields

Field history is not being used. The mapping below is what the connector writes
into `stage_events`.

| Funnel stage | Opportunity field | Confidence |
| --- | --- | --- |
| Lead | `CreatedDate` (standard) | certain |
| MQL | **none** | **no field exists** |
| SQL | `csbs__Underwriting_Date_Time__c` | **an interpretation — please confirm** |
| UW approved | `csbs__Approved_Date_Time__c` | certain |
| Offer | `Offer_Received_Date_Time__c` | certain |
| Funded | `csbs__Funded_Date_Time__c` | certain |

### MQL has no field

It is the one stage with nothing behind it. Two ways forward:

- **Derive it.** MQL is already defined for this tenant as a lead meeting the
  configured minimums — monthly revenue ≥ $10,000 and time in business ≥ 12
  months. Those are lead attributes known at creation, so the MQL timestamp can
  be the lead's creation time for any lead that meets them. This needs no new
  field and no admin work. It is a *computed* stage rather than an observed one,
  and the connector marks it as such so the funnel view can say so.
- **Add a field.** If MQL means something a human decides rather than something
  the form data implies, it needs its own datetime field and nothing else will do.

Derivation is the recommendation, on the condition that MQL really does mean
"meets the minimums". If it means "a rep qualified it", the derived figure would
be wrong in a way nobody would notice.

### `csbs__Underwriting_Date_Time__c` as SQL

This is the one mapping I am guessing at. The reasoning: a deal that reached
underwriting was necessarily sales-qualified first, so the underwriting
timestamp is an upper bound on when SQL happened. That makes the SQL count
correct and the Lead→SQL velocity slightly overstated.

If there is a closer field, or if deals reach underwriting without being
sales-qualified, say so — this is the kind of assumption that survives quietly
into a QBR and then loses an argument.

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

Present and populated on **16.4%** of closed-lost opportunities.

That is usable, and it is rendered with the gap shown: the breakdown carries an
explicit "not recorded" share and is never renormalised over the records that
happen to have a value. Renormalising 16.4% up to 100% would turn a mostly
unknown picture into a confident-looking chart, which is worse than saying
nothing.
