# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 21 September 2026, end of session.**

---

## Phase

Phase 4 — screens. Phase 3 (connectors and ingestion) is complete: Google Ads
and Salesforce are both live and the platform produces a real cost per funded
deal.

**Every screen was rebuilt on 18 September 2026 against design spec v2**, which
replaces §12 of the brief in full. §12 called for a hairline-and-whitespace
ledger; the client rejected the result as too plain and too text-heavy and
issued a modern SaaS analytics direction instead — left sidebar, elevated cards
on a grey-blue canvas, one blue, Inter, a mini chart on every KPI, green and red
deltas, no explanatory prose anywhere on a dashboard screen. The departures from
v2, and the product rules that survived it unchanged, are in
`docs/brief-amendments.md`, "§12 — replaced in full by design spec v2".

Executive, monthly performance, funnel, platform pages, connections,
reconciliation and People are built.

**Sign-in is an email address and a password as of 21 September 2026.** Magic
links and Google OAuth are gone, and with them `next-auth`. Accounts are created
by an admin on the People screen, which also resets passwords and removes
access. See "Sign-in is a password" below.

**The workspace and the delivery view were removed on 21 September 2026**, the
day after delivery tracking was finished. Zeeraa's delivery flow happens in
Slack and Drive, and an empty workspace is worse than no workspace: five empty
board columns and eleven commitments reading `Not recorded` is the shape of a
client being failed, not of a feature going unused. The screens, the API routes,
the S3 path and nine tables are gone — see
`docs/brief-amendments.md`, "§9, §10 and §14 — the workspace and the delivery
view are removed", and the section below.

## Done

- **Phases 1–2.** Schema, RLS (FORCE, membership-gated admin, mutation-tested),
  auth, tenant shell, Inngest jobs, Postgres writers, the MQL qualification bar,
  cold-outreach exclusion at ingest.
- **Google Ads, connected end to end.** `testConnection` healthy; the account
  reports `America/New_York` and so does the tenant, so no daily figure carries
  a boundary error.
- **90-day click backfill complete.** 2026-06-20 → 2026-09-17, 90 of 90 days,
  3,896 `ad_clicks`, every one resolving to a campaign. Captured on the last day
  2026-06-20 was reachable.
- **Campaigns and spend.** 43 campaigns, 401 `daily_metrics` rows,
  USD 78,873.97 over the window, 10 campaigns with spend.
- **Salesforce, synced.** 7,202 inbound leads (from 53,914 considered; 46,580
  excluded as out of scope, 132 unclassified), 712 opportunities, 1,759 stage
  events, 101 merges reconciled.
- **Click IDs recovered from converted Leads.** 243 of 243 converted leads
  carrying a `gclid` were walked to the opportunity they became, without the
  Opportunity-side field mapping existing. This is what makes any attribution
  possible today.

## Cost per funded deal — Google Ads, trailing 90 days

Both models agree; no deal has more than one touch yet, so first and last touch
cannot diverge.

| | |
| --- | --- |
| Channel spend (Google Ads) | USD 78,873.97 |
| **Deals attributed to Google Ads** | **9** |
| — of those, campaign known | 6 |
| — click aged out of `click_view`, channel still known | 3 |
| **Cost per funded deal (Google Ads)** | **USD 8,763.77** |
| Plausible range | USD 3,755.90 – USD 8,763.77 |
| Deals attributed to another channel | 0 |
| Deals attributed to nobody | 12 |
| (Context only) deals funded in period, all sources | 21 |

The 12 unattributed deals are **not** in the denominator and must never be. They
came from organic, referral, sales outbound and repeat business as well as
possibly from paid media, and nothing in the data says which. The range is what
they could do to the figure if every one of them turned out to be Google Ads —
the most generous reading available, not an estimate. See
`docs/brief-amendments.md`, "§8 — `cost_per_funded_deal` is a channel metric".

Coverage is limited by two things and only one is fixable:

1. **12 funded deals carry no click ID.** Leads that predate click-ID capture,
   or that arrived through a path that never set `gclid`. Not recoverable.
2. **3 carry a click ID whose click aged out of the 90-day window.** These still
   count for the channel — a `gclid` is a Google Ads click — but cannot be
   placed on a campaign. Permanent, and the reason the backfill ran when it did.

**Blended cost per funded deal is not computed.** It is a different metric with
a different denominator (total marketing spend over total marketing-sourced
deals) and needs every channel ingested before it means anything. With only
Google Ads live, a blended figure would be the Google Ads figure wearing a
broader name.

## Production database — Neon, migrated to 0018 on 21 September 2026

`neondb` on `ep-royal-cherry-b5xqgpoc` (us-east-2), PostgreSQL 18.6. Built from
empty: roles bootstrapped, tenants seeded, preflight green. **All 19 migrations
(0000–0018) are applied.** 0016 was applied on 21 September 2026 **after** the
deploy that removed the workspace — the order a removal requires. 0017 and 0018
followed the same day for password sign-in; see "The deploy order went wrong on
0018" below. Verified afterwards: the Auth.js tables and `users.email_verified`
gone, the password columns present, every remaining table still RLS-enabled and
FORCEd, and 720 opportunities untouched.

| | |
| --- | --- |
| Tables in `public` | 33, **all** with RLS enabled and FORCE |
| `public` schema owner | `zeeraa_owner` (NOSUPERUSER, NOBYPASSRLS) |
| Roles with BYPASSRLS or SUPERUSER | none of the seven `zeeraa*` roles |
| `app.membership_index` | 2 rows, zero drift against `memberships` |
| Memberships | `hello@zeeraa.com` zeeraa_admin · `lshah@spartancapitalgroup.com` client_admin |
| `assertRlsEnforced` | ok (19 Sep, as the app role) |
| `assertTransactionLocalContext` | ok (19 Sep, as the app role) |
| `assertDefinerFunctionsSafelyOwned` | ok (21 Sep) — all 11 `app.*` functions owned by `zeeraa_owner` |

The two preflight rows were **not** re-run on 21 September: both connect as
`zeeraa_app`, and that connection string lives in Vercel rather than in this
checkout. Their substance was checked directly instead — no `public` table
without RLS, none without FORCE, no `zeeraa*` role with `BYPASSRLS`. Put
`preflight` in the Vercel build command and the deploy answers this properly.

Neon's sample table `playing_with_neon` (20 rows) was dropped — `public` has to
be empty of anything without a policy or `assertRlsEnforced` refuses to serve.

**The wrongly-owned SECURITY DEFINER function is resolved — it was dropped.**
0013 had been applied as `neondb_owner`, which left
`app.enforce_asset_review_authority()` owned by a role carrying `BYPASSRLS`:
latent rather than leaking, but a SECURITY DEFINER body one edit away from
bypassing row level security silently, and the only `app.*` helper not owned by
`zeeraa_owner`. 0016 drops the function with the workspace it guarded. Verified
21 September 2026: **all ten `app.*` functions are owned by `zeeraa_owner`**,
and no `zeeraa*` role carries `BYPASSRLS` or `SUPERUSER`.

**It happened again on 0019, and is now caught by the deploy rather than by
hand.** `app.holds_any_membership()` landed owned by `neondb_owner` for the same
reason, was re-owned, and `preflight` gained a third check:
`assertDefinerFunctionsSafelyOwned` refuses when any `app.*` SECURITY DEFINER
function is owned by a role carrying `BYPASSRLS` or `SUPERUSER`. A note in this
file did not stop the second occurrence; a failing deploy will. Verified by
misowning a function and watching preflight refuse.

**The cause is still here.** The
documented route is `DATABASE_URL_OWNER`, the `zeeraa_owner` connection string
generated during bring-up, which is not in the working checkout — the only
production strings there are `NEON_DATABASE_URL` and `NEON_DIRECT_URL`, both
`neondb_owner`. `neondb_owner` is a member of `zeeraa_owner`, so the DDL
succeeds and tables, indexes and constraints carry the right owner (an index
inherits its table's); a `CREATE FUNCTION` does not. 0016 creates no objects, so
it left nothing misowned, but the next migration that creates a function will.

The durable fix is to put the real `DATABASE_URL_OWNER` in the environment
that runs migrations, so `pnpm db:migrate` connects as `zeeraa_owner` the way it
does locally. `scripts/migrate.ts` has no way to name a role, and setting
`role` as a postgres.js startup parameter does not work — it was tried and the
session still reported `neondb_owner`.

**Endpoints.** The runtime roles use the pooled host
(`...-pooler...`, PgBouncer transaction mode, which is what
`assertTransactionLocalContext` requires and what `client.ts`'s
`prepare: false` is for). The owner and maintenance roles use the direct host,
because migrations take advisory locks. Put
`pnpm --filter @zeeraa/db preflight` in the Vercel build command so a wrong
endpoint breaks the deploy rather than quietly disabling isolation.

**The isolation model had to change to deploy at all.** The SECURITY DEFINER
policy helpers used to carry `SET app.maintenance = 'on'`; only a true
superuser can grant SET on a custom parameter, and Neon has none, so migration
0002 could not run. The helpers now read `app.membership_index`, a mirror in the
`app` schema with no grant to any application role. FORCE, the maintenance gate
and the absence of BYPASSRLS are all unchanged, 16 of 16 mutations are still
killed, and two new mutations cover the mirror's own failure modes. Full
reasoning in `docs/brief-amendments.md`, "§5 and §12 — the policy helpers no
longer elevate".

**Routine syncing is on Vercel Cron as of 18 September 2026.** `vercel.json`
schedules `/api/cron/sync` hourly; it runs the incremental path only — two days
of paid media, Salesforce since its last completed read — and measures 5–7
seconds against Spartan, inside the 60s function limit. Protected by a
`CRON_SECRET` bearer check that fails closed. The Inngest serve route and
module are gone, along with the dependency; the ninety-day backfill remains
`scripts/run-scheduled.ts` and the per-platform scripts, which is where §7's
durable-steps argument actually applies. See `docs/brief-amendments.md`,
"§7 — routine syncing runs on Vercel Cron, not Inngest".

"Sync now" now calls the same incremental path per tenant and reports the real
outcome in the UI rather than that an event was queued.

**Still to do before the app serves traffic.**

1. **Resolved 19 September 2026.** All three stored credentials — `google_ads`,
   `salesforce` and `meta` — decrypt under the `ENCRYPTION_KEY` now set in
   Vercel (fingerprint `aff4452d0163`, sha256 of the key, first 12 hex).

   The earlier note here was diagnosed backwards. Google Ads and Salesforce were
   never encrypted with the wrong key; **this Codespace holds a stale
   `ENCRYPTION_KEY`** (`67e4309c2482`) as a Codespaces secret, and reading the
   blobs from here made working credentials look broken. The one that really was
   wrong was `meta`, written from this shell under the stale key.

   **The Codespaces secret is still stale and should be updated to match
   Vercel.** Until it is, anything run from here uses the wrong key — but it can
   no longer do damage silently: `set-credentials` now refuses to write when any
   other connection for the tenant fails to decrypt under the current key,
   naming the platforms, and `--rekey` is the deliberate exception for
   re-encrypting everything under a new one.
2. Ingestion has started: 7,327 leads and 720 opportunities as of
   19 September 2026. The 90-day `click_view` window is the one thing with an
   expiry, so `run-scheduled nightly` against Neon should not go long unrun.
3. `CRON_SECRET` must be set in Vercel or the hourly endpoint refuses (503),
   and `ALOWARE_WEBHOOK_SECRET` likewise for the call webhook — both fail
   closed, so an unset secret is a refusing endpoint rather than an open one.

   **Sign-in needs no environment variable at all** as of 21 September 2026.
   `DATABASE_URL_AUTH` is the whole configuration. These are now dead and should
   be **deleted from the Vercel project**: `NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
   `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`,
   `EMAIL_FROM`, and from the earlier removal `S3_*`, `SLACK_*`,
   `BLOB_READ_WRITE_TOKEN` and `INNGEST_*`. Nothing reads any of them, and an
   unused secret is one more thing to rotate.

   **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are the one pair to check
   before deleting.** They were the sign-in OAuth client. The Google Ads
   connector holds its own credentials encrypted in the connection row, per
   tenant, so it does not read these — but confirm against the Vercel project
   rather than on this note.

## Three unmeasured items became measured (18 September 2026)

Four things on the funnel rendered `Not measured`. Three were recoverable from
data already in the org; the reasoning and the coverage limits are in
`docs/brief-amendments.md`, "§8 and §9.3 — three of the four unmeasured items
are now measured".

| Stage | Figure, trailing 90 days | Coverage limit shown on screen |
| --- | ---: | --- |
| UW approved | 114 | Field history begins 2026-03-20; silent before it |
| Offer rate | 58.8% (67 of 114) | Gated below a denominator of 10 |
| MQL | 649 | 57.6% of leads assessable |
| Declines | 362 deals (389 transitions) | 89% of closed-lost deals |

Over all 7,296 inbound leads the bar reads 1,206 qualified (16.5%), 2,903
unqualified (39.8%), 3,184 undeterminable (43.6%). The single largest
obstruction is `MIYB_Years_in_Business__c`, 1,075 leads.

**Three numbers on screen were wrong and are corrected.** Each was caught by
the figure looking implausible, and each had a different cause:

1. **MQL read 26 and a 0.7% qualification rate.** The stage was counted from
   `stage_events`, which are keyed by opportunity, so it counted the qualified
   leads that went on to convert. MQL is a judgement about a *lead*; migration
   0010 adds `qualified_leads` as a stage source and the rate is 17.0%.
2. **MQL → Application read 1,696%, then 68%.** The first was caught by a guard
   that fires when a ratio exceeds 100%. The second is the same non-nested
   populations at the right grain, looking perfectly plausible — applications
   are not drawn from MQLs, because the bar is computed from what a lead
   reported rather than being a gate. Nesting is now declared on the stage, not
   inferred from the arithmetic.
3. **Declines read 555 against 362 actual deals.** Bucket rows are distinct per
   *day*, so a re-underwritten deal counted twice, and the window total summed
   every month that overlapped the range. Buckets now count one deal once per
   stage per bucket, and a window total is a distinct count.

Also fixed while wiring it up: the writer no longer overwrites a stored MQL
verdict with a null one (a re-upsert without the bar would have erased
judgements), the band parser no longer drops a zero lower bound or reads the
`m` in "Months" as "million", and `reconcileDeletesAndMerges` clamps both
`getDeleted` window bounds instead of throwing the whole sync.

## Lender grain, and the offer rate that was not one (18 September 2026)

An audit of the org — prompted by an offer rate of 58.8% looking too high for
MCA — found that the funnel was reading lender decisions off the deal. Full
reasoning in `docs/brief-amendments.md`, "§8 — Offer rate is blocked, because it
was measuring data entry" and "§4, §8 and §9.3 — submissions are the grain the
funnel was missing".

**Offer rate is retired.** Approval and the first lender offer are the same
event: median 0.0 hours apart, 110 of 112 within an hour, and 98 of the offer
records predate the stage change. What the rate measured is whether somebody
typed a date into `Offer_Received_Date_Time__c` — 57 of 115 approved deals have
it, 112 hold an offer record. It also divided populations that do not nest: 10
of 67 offers belong to deals with no approval event.

**`csbs__Submission__c` is ingested at lender grain.** 1,427 submissions, 419
opportunities, 6 lenders, from 2026-06-18. One table, migration 0011, with the
usual RLS treatment plus two mutations and three isolation tests.

| | Submissions | Offered | Declined | Offer rate of decided |
| --- | ---: | ---: | ---: | ---: |
| CFG | 419 | 73 | 137 | 34.8% |
| Spartan Capital | 310 | 27 | 131 | 17.1% |
| Elevate Funding | 348 | 21 | 164 | 11.4% |
| Forward Financing | 347 | 9 | 158 | 5.4% |
| **All lenders** | **1,427** | **131** | **590** | **18.2%** |

706 submissions are undecided and excluded — 693 awaiting an answer, 13 that
never completed. They are on the metric, not in a caption: a reader assuming the
denominator is every submission is out by a factor of two.

**Decline reasons are measured, at lender grain.** 123 citations across 121
lender declines. Coverage is rendered per month and never summed, because the
field is being adopted: 0% of June's declines, 15.4% of July's, 9.1% of
August's, 30.5% of September's. A reason *per deal* stays blocked —
`Loss_Reason__c` is abandoned and a deal declined by three lenders has no single
reason in the CRM.

**The funnel no longer assumes stages progress in order.** Nesting is measured
per transition against the stage events, with `max_rate_leakage` (2%, a config
row) deciding whether a rate renders with its exclusion stated or is withheld.
Every stage card states how many of its deals were later declined — 47 of 67 at
Offer. The Salesforce sync reports `succeeded` again, the absent
`csbs__Decline_Reason__c` having been dropped from the mapping now that the
reason is read where it lives.

## Call tracking, from Aloware (18 September 2026)

Built as a direct Aloware integration, not by reading the 30,093
`Aloware_Call__c` records in Salesforce: that object is a copy whose
completeness depends on the vendor's own CRM integration, and a gap in it would
look here like a quiet day on the phones. Full reasoning in
`docs/brief-amendments.md`, "§7 and §9 — call tracking, from Aloware directly".

**The blocked state was wrong, not merely stale.** It said the vendor had not
been selected. Aloware has been live since June.

| | |
| --- | ---: |
| Calls imported (19 Jun – 17 Sep) | 28,863 |
| SMS skipped, counted not ingested | 252 |
| Connected (talk time ≥ 30s) | 3,503 |
| Attempted | 23,358 |
| — of which answered, under the threshold | 19,852 |
| Abandoned, excluded from both | 2,002 |
| Calls matched to a lead | 27,382 of 28,862 (94.9%) |
| Speed to lead, median | 11h 35m (p90 11d 18h) |
| Called within five minutes | 15.1% of leads called |
| Attempts per lead | mean 7.6, median 4 |

`completed` is not a conversation: the vendor marks 26,311 calls completed and
13,376 of those talked for under ten seconds. `connected` therefore requires
talk time past `aloware.connectedMinTalkSeconds` — a config row, default 30s,
rendered on the card because the sensitivity is steep (23,355 connected at 1s,
9,979 at 10s, 3,503 at 30s).

**The CSV lives in `data/private/`, which is gitignored, and is PII.** Only the
columns needed are ingested; names, emails, note bodies and recordings are not
read. The two PII columns stored — contact number and agent name — appear on no
screen.

**Going forward:** `POST /api/webhooks/aloware/{tenant}`, bearer-authenticated
with `ALOWARE_WEBHOOK_SECRET`, idempotent on Communication ID because that is
the upsert key. Verified end to end: a repeated post produces one row, an SMS
is rejected with its reason, a bad body is a 400, a wrong secret is a 404.

**Three bugs this surfaced and fixed.** `sync-salesforce --since` was read and
documented but never passed to the sync, only to the click-ID backfill — so a
"full re-pull" silently ran incrementally. The export's timestamps carry no
timezone, and read as UTC every call would have landed four hours early, which
would have looked like a slow desk rather than a bug. And the seed's connection
upsert key includes the account identifier, so renaming one inserted a second
row and left the stale one rendering — now pruned, but only for rows holding no
credentials.

## The workspace, and delivery counts that come from it (19 September 2026 — removed 21 September)

**Everything in this section was removed on 21 September 2026.** It is kept
because the two bugs at the end of it are worth not re-introducing, and because
the reasoning about what "delivered" means is the reasoning that would have to
be redone if this ever returns. See "The workspace and delivery view are
removed" below for what actually stands today.

Delivery read `Not recorded` against all eleven commitments because nothing
wrote to `assets` or `deliverable_records`. The loop is now closed: upload →
tag to a commitment and a period → client approves or sends back → the delivered
figure moves. Full reasoning in `docs/brief-amendments.md`, "§10 and §14 — asset
storage is S3, and a delivered count is derived from approvals".

**Storage is AWS S3, not Vercel Blob.** The client's decision. One private
bucket, all public access blocked, keys `tenant/{tenant_id}/assets/{id}/v{n}/…`,
uploads by presigned PUT straight from the browser and downloads by a signed GET
produced per request behind an RLS-checked read. The application's IAM policy
carries no `s3:ListBucket` — so a leaked credential cannot enumerate what other
tenants hold — and no `s3:DeleteObject`, which makes "old versions are never
deleted" a property of the credentials. Bucket, CORS and IAM in
`docs/asset-storage.md`; `BLOB_READ_WRITE_TOKEN` is gone from `.env.example`.

**Three states, not two.** `Not recorded` where no artifact exists and no count
was written; `0` once an artifact is in front of the client but none is approved
yet; the approved count thereafter. A draft in Zeeraa's own column triggers
nothing. Approved artifacts decide the figure wherever they exist, and a
hand-recorded count — for backlinks, tracked prompts, concurrent tests, which
produce no artifact — is used only where there are none. Where both exist the
tally is stated beside the figure and never added to it.

**A superseded version counts toward nothing**, so one article approved at v1
and again at v2 is one article delivered. Migration 0013 adds the partial unique
index that keeps a version chain a chain.

**Only a client admin can approve, and that is a trigger rather than a hidden
button.** `app.enforce_asset_review_authority()` on `assets`: into `approved` or
`changes_requested` requires `client_admin`, into `submitted`/`published`
requires a Zeeraa role, and the approver column must name the user in context. A
Zeeraa admin holds every other power in this product and deliberately not this
one — a delivered figure Zeeraa could raise on its own behalf is not a
compliance record. Thirteen tests in `packages/db/test/asset-review.test.ts`;
six new mutations, **26 of 26 killed**.

**Two bugs found and fixed while building it.**

1. The correlated subquery that asks "does a later version of this row exist"
   rendered the outer column unqualified, so it bound to the inner alias and the
   condition became `later.supersedes_asset_id = later.id` — never true, no
   error, every row reported as not superseded. It would have double-counted the
   first article approved at v1 and again at v2. It is now one named constant in
   `apps/web/src/lib/asset-sql.ts` with a test on its generated SQL.
2. `Items delivered` on the delivery view summed every commitment's delivered
   figure — pieces plus pages plus links. Invisible while everything read `Not
   recorded`; with real counts it reported 37. Replaced by `Artifacts approved`,
   which is one unit.

Verified end to end against a local MinIO standing in for S3: upload, submit,
a Zeeraa admin refused at approval, the client admin approving, a rejection with
its reason, a v2 replacing a sent-back v1, the delivered figure moving 1 → 2 and
not 1 → 3, the object returning 403 to an anonymous GET, and the signed
redirect serving the file. Screenshots at 1440px and 390px, no horizontal page
scroll at either.

## The workspace and delivery view are removed (21 September 2026)

Zeeraa's delivery flow happens in Slack and Drive. The workspace was built for a
flow that does not exist, and an empty one is worse than none: the board reads
`Empty` in all five columns and eleven commitments read `Not recorded`, which a
client reads as being failed rather than as a feature going unused.

Removed: the `/{tenant}/delivery` and `/{tenant}/workspace` screens, the three
`/api/assets` routes, the `delivery` table of the CSV export, `lib/storage.ts`
and the whole S3 presign path, both `@aws-sdk` packages, `packages/core`'s
`delivery.ts`, and the sidebar group that held the two screens.

**Nine tables dropped**, in migration `0016_remove_workspace_and_delivery.sql`:
`assets`, `asset_types`, `asset_comments`, `deliverable_commitments`,
`deliverable_records`, `sla_commitments`, `sla_events`, `mentions` and
`activity_log`. With them go `app.enforce_asset_review_authority()` and its
trigger, five enum types, `memberships.slack_user_id`, and the
`sla_compliance` and `delivery_completion` rows in `tenant_metrics`, whose
formulas named functions that no longer exist.

**The activity log went too.** It was checked first: `lib/assets.ts` was its
only writer and nothing read it, so after the workspace it would have been an
empty table with two restrictive policies and a mutation guarding it. Dropped on
the client's decision. `0000` has its shape and `0001` has the append-only
policies if an auditable act ever returns.

**The notification bell is gone**, because its only destination was the
workspace and nothing has ever written a `notifications` row. The table, its
policies and its grants stay: it is a table waiting for a feature rather than
the remains of one.

**Deploy order: code first, schema second.** The reverse of an addition. Between
the deploy and the migration the running application is simply not asking for
those tables; do it the other way and it spends the gap querying tables that
have already been dropped.

**One thing in that migration is worth reading before writing another like it.**
The `DELETE` against `tenant_metrics` is bracketed by `NO FORCE` / `FORCE ROW
LEVEL SECURITY`. `tenant_metrics` carries FORCE and its policies name
`zeeraa_app`, `zeeraa_jobs` and `zeeraa_maintenance` — not the owner role
migrations run as — so without the bracket the owner is default-denied, the
statement matches zero rows, reports `DELETE 0` and the migration succeeds
having changed nothing. It did exactly that on the first run, locally, and the
only reason it was caught is that the row count was checked afterwards. `ALTER
TABLE` takes ACCESS EXCLUSIVE, so no session sees the table unforced.

Verified: `pnpm -r typecheck` clean, 502 tests across 34 files green, a fresh
database migrated 0000 → 0016 with every remaining table still carrying RLS, and
the mutation suite re-run against a throwaway database — **24 of 24 killed**,
none surviving and none inapplicable. Seven mutations went with the tables they
guarded: the two `assets` policy mutations, the review trigger, the approval
role check, the version-chain index, the `deliverable_records` upsert key and
the `activity_log` append-only pair.

### The `.env` trap, and the split that closed it (21 September 2026)

`.env` defined `DATABASE_URL_JOBS` and `DATABASE_URL_MAINT` **twice** — local
first, then Neon further down, and the later definition wins. Sourcing the whole
file before `pnpm test` therefore pointed the ingestion and maintenance roles at
production while the owner seeded locally, and five isolation tests failed on
foreign keys to a tenant that existed only on localhost.

Nothing was written to Neon: every fixture insert failed on
`*_tenant_id_tenants_id_fk` and rolled back, confirmed afterwards by querying
production for the fixture rows. The foreign key caught it, which is luck rather
than a control — the suite also writes `daily_metrics`, which has no such
dependency.

**Fixed.** `.env` now defines each `DATABASE_URL_*` exactly once, all local. The
four production strings — `NEON_DATABASE_URL`, `NEON_DIRECT_URL` and the Neon
`DATABASE_URL_JOBS` / `DATABASE_URL_MAINT` — moved to **`.env.neon`**, which
nothing loads on its own:

- Next.js's loader knows `.env`, `.env.local` and `.env.<NODE_ENV>[.local]` and
  ignores any other suffix, so `pnpm dev` cannot pick it up.
- No package here uses `dotenv`; every script reads `process.env` directly, so
  the file is inert unless sourced by name.
- `docker-compose.yml` has no `env_file`.
- `.gitignore` now reads `.env.*` with `!.env.example`. The three rules it had
  (`.env`, `.env.local`, `.env*.local`) did **not** match `.env.neon`, so
  `git add -A` would have committed the production connection strings.

`.env.neon` deliberately defines **no** `DATABASE_URL` and no
`DATABASE_URL_OWNER`. Sourcing it leaves `db:migrate`, `db:seed`, `db:reset` and
`bootstrap` pointed at localhost — which is what keeps `mutation-test.ts`, which
drops the schema it points at, from ever reaching Neon. Name the URL on the one
command that needs it:

```bash
DATABASE_URL_OWNER="$NEON_DIRECT_URL" pnpm --filter @zeeraa/db migrate
```

**And a backstop, because an export outlives the command it was sourced for.**
`packages/db/test/fixtures.ts` now refuses to run when any `DATABASE_URL*` in
the environment resolves to a non-local host, naming the offenders. It checks
every such variable rather than the four it reads, because `job-role.test.ts`
builds its own from `DATABASE_URL_JOBS` and `organic-isolation.test.ts` reaches
it through `getJobsDb()`. An unparseable URL counts as remote. CI is unaffected
— its Postgres is a service container on `localhost:5432` — and
`ALLOW_REMOTE_TEST_DATABASE=yes` is the deliberate override for a disposable
remote branch.

Verified three ways: sourcing `.env` alone now runs 90 of 90 green entirely
locally (the case that used to fail); sourcing `.env` then `.env.neon` is
refused by name, citing `DATABASE_URL_JOBS` and `DATABASE_URL_MAINT`; and
`git check-ignore` confirms `.env`, `.env.neon` and both `.env.local` files are
ignored while `.env.example` stays tracked.

## Sign-in is a password (21 September 2026)

Magic links over Resend and Google OAuth are removed. Sign-in is an email
address and a password; an admin creates the account on the new **People**
screen, the app generates the first password and shows it once, and the person
is required to replace it before reaching anything. **No email leaves this
product.** Full reasoning in `docs/brief-amendments.md`, "§11 and §14 — sign-in
is a password, and accounts are created by an admin".

| | |
| --- | --- |
| Credential | argon2id, 19 MiB / t=2 / p=1, PHC format, ~12 ms per hash |
| Session | a row in `sessions`, 256-bit opaque cookie `zeeraa_session` |
| First login | `users.must_change_password`, enforced in `requireTenant` |
| Reset | new password issued, every session of that user closed |
| Recovery | none — an admin reset is the replacement |

`next-auth` and `@auth/drizzle-adapter` are gone. **Auth.js does not support the
Credentials provider with database sessions** — it requires a JWT strategy — so
keeping it would have meant giving up the revocation guarantee or minting the
session row by hand anyway. The old `api/dev-signin` route already minted one,
so the mechanism was proven before it was adopted.

**Every pre-existing account has a null `password_hash` and cannot sign in.**
Deliberate — there is no default password and no grace period — but it needed a
way back in, because passwords are set on the People screen and the People
screen requires being signed in. Without one, this deploy locks everybody out of
an application whose only entrance is to already be inside it.

```bash
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db set-password hello@zeeraa.com
```

Generates the password rather than taking it as an argument, so it never reaches
a shell history; prints it once; sets `must_change_password`; closes every
session the account holds. Not a web route and not seedable — the gate is
holding the maintenance connection string.

### Two migrations, in two places in the sequence

`0017` adds only and runs **before** the deploy. `0018` drops `accounts`,
`verification_tokens` and `users.email_verified` and runs **after** it. They
cannot be one migration: the old deploy hydrates every authenticated request
through the Drizzle adapter, which selects `users.email_verified`, so dropping
it while the old code served would have taken down every signed-in page rather
than just the sign-in form. Production held four live sessions at the time, so
the window was real.

### What the policies now allow

- `users_admin_create` — an admin may create an account. Checks the actor, not
  the row: a new user has no membership yet and so nothing tenant-scoped to test.
- `users_admin_manage` — an admin may reset the password of somebody in the
  tenant they are working in.
- `memberships_admin_write` / `_remove` — widened to client admins **for client
  roles only**. `zeeraa_member` and `zeeraa_admin` are what `canSwitchTenant`
  lets out of the tenant, so a client admin able to grant one could mint an
  account that reads every other client.
- `memberships` lost its table-wide UPDATE grant. `memberships_update_own` was
  letting anybody update any column of their own row — including `role`, which
  `app.membership_index` is maintained from, so the promotion would have taken
  effect at once. Unreachable before this work, because nothing wrote to the
  table; closed now that something does. The grant is column-scoped to
  `email_preference` and `slack_enabled`, because RLS cannot restrict columns.

### Three bugs found by running it rather than reading it

1. **The decoy hash threw at module load.** `randomInt(2 ** 48)` is one past
   Node's ceiling, and it ran at import, so every page importing `password.ts`
   answered 500 — not a failed sign-in, a dead screen. `randomBytes` now.
2. **Every successful account creation reported "an account already exists".**
   The `users` SELECT policy admits only people who share the current tenant, so
   a just-created account is invisible until its membership row exists. Reading
   back to see whether the insert landed returns nothing on the happy path.
   `createUser` now detects the duplicate from the `23505` unique violation.
3. **Every form on the People screen was JavaScript-only.** They rendered
   `action="javascript:throw new Error('React form unexpectedly submitted.')"`
   while the sign-in form posted normally. A server action that closes over a
   *function* cannot have its bound arguments encrypted, and React responds by
   dropping the no-JS fallback silently. The shared `back()` helper moved to
   module scope and all five forms post like the sign-in form does.

### The handover panel, after a report that no password appeared

Reported 21 September 2026: "after creating a user I didn't see a password
displayed." The password **was** being displayed — reproduced in dev, in a
production build, in Chromium and without JavaScript. What the check turned up
instead was three real faults around it, one of which explains the report.

1. **"Add an existing account" succeeded in complete silence.** No confirmation,
   no message, nothing — the page reloaded and a row appeared somewhere in the
   middle of the roster. An admin who used that form rather than "Create an
   account" would see exactly what was reported. Both it and "Remove" now say
   what happened.
2. **The password travelled in the query string.** It worked, and it wrote the
   credential into browser history, the deployment's access logs (Vercel records
   the request path) and the `Referer` of any link followed from the page. It
   also made the panel's own "shown once" untrue. It is now a short-lived
   `httpOnly` cookie scoped to `/{tenant}/people`, dismissed with a button
   rather than by navigating away, and it survives a refresh.
3. **Fixing (2) exposed the bug behind the report.** With the password out of
   the URL the redirect target became the URL the admin was already on, so the
   browser preserved scroll position — and the panel renders at the top while
   the form that produces it is at the bottom, past the roster. It appeared
   off-screen above them. Every action now redirects to `#handover` or
   `#message`, which lands the result in view whether the navigation is handled
   by the router or by the browser.

Two more things found while checking: the `Actions` column header used
`sr-only`, which is `position: absolute`, and with no positioned ancestor it
escaped the table's horizontal scroll container and stretched the document —
**205px of horizontal page scroll at 375px**, which spec v2 forbids outright and
which no other screen has. The header is visible now and the scroll container is
`relative`. And `redirect()` was being called inside a `try` whose `catch`
inspects the error: `redirect` works by throwing, so the control-flow exception
was caught and survived only because the fallthrough rethrew it.

The panel now carries a Copy button that reports failure rather than silently
doing nothing — `navigator.clipboard` is absent outside a secure context, and an
admin who believes they copied a password and did not will paste the wrong thing
to somebody waiting on it.

### Removing access stranded the account (21 September 2026)

Reported the same day: removing `lshah@spartancapitalgroup.com`'s membership
made the account unreachable. "Create an account" said it already existed; "Add
an existing account" said no account here. Both were telling the truth and
neither could finish.

The lookup runs under `users_visible_within_tenant`, which admits a row only
when it is the caller's own or the target shares the current tenant. An account
with no membership anywhere shares nothing with anybody, so it is invisible to
every admin while still occupying its address on a global unique index.

`0019` adds a second permissive SELECT policy for exactly that case, with the
unattached test behind a SECURITY DEFINER helper reading `app.membership_index`
— as an invoker-rights function it would see only the caller's own memberships,
so a user attached to another engagement would read as unattached and that
engagement's roster would appear. Three mutations cover the policy and the
helper.

An account that belongs to a **different** engagement stays invisible, to Zeeraa
as much as to a client. `scripts/grant-membership.ts` moves one, on the
maintenance connection:

```bash
DATABASE_URL_MAINT=... pnpm --filter @zeeraa/db grant-membership <email> <slug> <role>
```

**Production was repaired with it before the fix shipped**, since the deadlock
had no route out through the UI: `lshah@spartancapitalgroup.com` is
`client_admin` in Spartan again. The orphan it left behind —
`lshah@spartancaptialgroup.cm`, a mistyped address (`captial`, and `.cm`) — was
deleted on 21 September 2026 with the new `delete-account` script. Production
holds two accounts: `hello@zeeraa.com` (zeeraa_admin) and
`lshah@spartancapitalgroup.com` (client_admin), and `app.membership_index`
matches `memberships` at two rows.

`delete-account` **refuses while the account holds any membership.** Removing
access and deleting an account are different acts: the People screen removes a
membership and leaves the account, because it may hold other engagements and
because history should survive somebody leaving one client. A cascade through
`memberships` would be a revocation with nothing recording that it happened, so
access comes off on the screen first, deliberately.

Verified in a browser, as the whole reported cycle: create, remove, create
refuses and points at the other form, add-existing succeeds, granting twice says
"already had access", and an address with no account anywhere still refuses.

### Verified

`pnpm -r typecheck` clean, 524 tests across 36 files, **30 of 30 mutations
killed** (six new: two on the client-admin role limit, one on the column grant
that closes self-promotion, one on account creation, one on the reset policy,
one on the session table), a production build with the native argon2 module,
and the flows driven against the running app rather
than asserted: wrong password and unknown address return byte-identical
responses; a seeded account is forced to `/change-password` and cannot reach the
dashboard until it changes; the old password stops working and exactly one
session survives the change; a client admin creates an account, receives the
one-time password, and that account signs in and is forced to change; a client
viewer is refused the People screen; a forged `role=zeeraa_admin` post is
refused, and so is `role=zeeraa_member`.

### The deploy order went wrong on 0018

The split into expand (`0017`) and contract (`0018`) was made precisely so the
contract would land after the deploy. Then both were applied at once, because
**`pnpm db:migrate` applies every pending migration** — drizzle's migrator has no
"up to N" — and holding `0018` back needed a deliberate step that was not taken.

So `accounts`, `verification_tokens` and `users.email_verified` were dropped
while the old deploy was still serving. The old code selects
`users.email_verified` on every authenticated request, so for the length of one
Vercel build every signed-in page on production would have answered 500. Four
sessions were live at the time. The window was closed by pushing immediately;
the new deploy went out and `/signin`, `/change-password` and `/spartan` all
answer correctly.

**Next time, hold the contract migration back rather than trusting the order of
two commands.** The migrator applies the whole pending set, so the only reliable
way to stage them is to not have the later file in the tree when the earlier one
runs — commit the expand, migrate, deploy, then commit the contract and migrate
again. A split that both halves of still run together is a comment, not a
control.

### Production accounts, bootstrapped 21 September 2026

Both accounts had a null `password_hash` after `0017`, as designed, and were
given one with `set-password`:

| | |
| --- | --- |
| `hello@zeeraa.com` | zeeraa_admin, password set, must change on first sign-in |
| `lshah@spartancapitalgroup.com` | client_admin, password set, must change |

Every session was cleared afterwards, so the next sign-in on production is a
password sign-in. Verified against the live deployment: a wrong password returns
`/signin?error=1`, the correct one signs in, and `/spartan` redirects to
`/change-password` until the password is replaced.

## Improvement direction is a property of the metric (21 September 2026)

Audited every place a cost metric reaches a screen — executive hero, KPI row,
monthly performance, the month-over-month bar chart, the platform pages, the
monthly table — after a question about whether cost per funded deal was being
treated as lower-is-better.

**It was, everywhere.** No miscolouring on any screen, and every configured row
on production was already correct: `cost_per_funded_deal` and `cpa` both `down`,
`total_program_cost` and `stage_velocity` `down`, rates `up` apart from
`duplicate_rate` and `resubmission_rate`. The platform pages render CPC, CPM and
cost per conversion as plain figures with no delta and no colour, so there was
nothing there to be wrong.

What was wrong was that nothing guaranteed it. Direction lived in
`tenant_metrics.improvement_direction` — a per-tenant config row — and each card
looked it up by a string key. A missing row rendered neutral, a mis-seeded row
rendered green on a rising cost, and `cpc`/`cpm`/`cost_per_conversion` had no
rows at all.

It is now declared in `packages/core/src/metric-direction.ts`, keyed on
`formula_key`, because the formula fixes the direction and the metric key is
just the tenant's name for an instance of it. The config column is the fallback
for a formula core does not know, and is overridden where they disagree.
**Nothing defaults to `up`**: an undeclared formula is neutral, and one whose
name is cost-shaped is `down`, so `cost_per_mql` added next month is right
without anybody remembering. `paid_media_spend` is declared explicitly neutral
rather than omitted.

Four tests hold it, and one of them reads the TSX sources and fails if any
screen states a direction as a literal — verified by hardcoding one and watching
it fail. Behaviour is unchanged: every key in use resolves to exactly what it
resolved to before, checked against the real database.

Nothing to verify on screen today — the cost-per-deal delta renders "not
ingested before 2026-06-20" rather than a number, because the baseline period
predates ingestion and §12 forbids dividing by it.

## The executive hero tracks the engagement ramp (21 September 2026)

The cost-per-funded-deal panels now show actual against **what the engagement
contracted**, for Google Ads. Full reasoning in `docs/brief-amendments.md`,
"§12 — the executive hero tracks the engagement ramp".

| | |
| --- | --- |
| Model | 8-month CPF ramp, $4,000 → $2,705, Google Ads only |
| Stored in | `engagement_targets` (tenant, platform, month_index), new in 0020 |
| M1 lands on | `engagement_start_month` in `tenant_config` — **null today** |
| Meta | no target, no curve, no gap line |

**The start month is not set, and that is the current on-screen state.** The
Google Ads panel shows actual with no target line and one sentence: "Ramp
targets begin when the engagement starts." Guessing would mean assuming the
engagement began when ingestion did — June 2026 — which places M1 four months
back and reports the client as far behind a schedule nobody started.

To switch it on, set the month and nothing else:

```sql
update tenant_config set value = '{"month": "2026-10"}'::jsonb
  where key = 'engagement_start_month' and tenant_id = '<tenant>';
```

35 of 35 mutations killed — including one that found a vacuous assertion in
the new isolation test, which passed whether or not the policy existed because
dropping it returns zero rows rather than the wrong ones.

Verified locally by doing exactly that: the dashed curve appeared beneath the
measured line and the gap read `Aug · $5,087 above the M3 target of $3,496`,
which is M3 of a June start. Reverted to null afterwards, and production has
never had it set.

**The gap is month against month, not window against month.** The figure above
it covers the selected window; the ramp contracts a monthly number. The gap uses
the last completed, non-provisional month that has both a target and a
measurement, and names it.

**Still missing, and deliberately null:** the budget, CPA, approvals and
funded-deal targets. `engagement_targets` has a nullable column for each and
only M1's budget ($30,000) has been supplied — the rest await the model file
rather than being invented. Nothing renders them yet.

## Meta Ads, connected and backfilled in production (19 September 2026)

Neon carries the full 90 days as of 19 September 2026. The three passes below
were run against production in this order; none of them happens on a schedule.

| | Neon, trailing 90 days |
| --- | ---: |
| meta `daily_metrics` | 102 rows, 88 days, **USD 17,865.50** |
| meta campaigns | 19 |
| meta rows in `opportunity_click_ids` | **58**, all `lead_conversion` |
| meta rows in `attribution` | 58 per model |
| leads with `click_id_type = 'meta'` | **957** (484 in window) |
| Cost per funded deal · Meta | **USD 17,865.50** over 1 deal, range 1,488.79 – 17,865.50 |
| Cost per funded deal · Google Ads | **USD 8,854.67** over 9 deals, range 3,984.60 – 8,854.67 |

Before the backfill production showed USD 516.51 and no attributed deal: the
hourly cron had pulled its two-day spend window and nothing else, which is what
it is designed to do. Google Ads looked complete only because it had been
backfilled separately in an earlier session.

## Meta Ads, connected (19 September 2026)

Campaign grain, read synchronously — 19 campaigns, 102 rows for 90 days in one
call. The submit-then-poll Insights job that made Meta look like the hardest
connector is only needed at ad grain over long windows. Full reasoning in
`docs/brief-amendments.md`, "§7 and §8 — Meta Ads, at campaign grain, with
channel-only attribution".

| | Google Ads | Meta Ads |
| --- | ---: | ---: |
| Spend, trailing 90 days | USD 79,175.75 | USD 17,857.33 |
| Impressions | 60,864 | 170,471 |
| Clicks | 3,588 | 5,137 (link clicks) |
| Funded deals attributed | 9 | 1 |
| — campaign known | 6 | **0, permanently** |
| Cost per funded deal | USD 8,797.31 | USD 17,857.33 |
| Plausible range | 3,958.79 – 8,797.31 | 1,488.11 – 17,857.33 |

**Meta attribution is channel-level and always will be.** Google serves
`click_view`, which resolves a `gclid` to a campaign; Meta publishes no
equivalent for `fbclid` at any grain. So `metaConnector` has no `fetchClicks`,
`ad_clicks` never holds a Meta row, and every Meta deal reports as *click
without campaign* — a state the model already had for Google clicks that aged
out of the window. This is the shape of the platform, not a gap to close.

**The Salesforce side needed no admin work.** `acq_fbclid__c` already existed on
Lead *and* Opportunity, readable, and already in the Lead → Opportunity
conversion mapping. 972 leads carry it; 58 converted leads carry it without a
gclid and became an opportunity; 0 opportunities carried it, which is expected
because mapping copies at conversion and never retrospectively. The backfill
recovered all 58 and moved one funded deal out of the unattributed bucket.

**Two configured readings, both measured before being chosen.** `clickMetric`
defaults to `inline_link_clicks` (5,137) rather than `clicks` (8,074), because
Google Ads' `clicks` means "went somewhere" and the two sit in one column with a
totals row. `conversionActionTypes` defaults to `['lead']` alone, because Meta's
`actions` array contains rollups beside their components — `lead` (1,756) *is*
`onsite_web_lead` (921) plus `onsite_conversion.lead_grouped` (835), and nothing
marks which nest.

**Operationally:**

```bash
pnpm --filter @zeeraa/db   set-credentials spartan meta      # META_ACCESS_TOKEN
pnpm --filter @zeeraa/jobs test-connection spartan meta
pnpm --filter @zeeraa/jobs sync-meta        spartan [--days 90]
pnpm --filter @zeeraa/jobs backfill-click-ids spartan [--since YYYY-MM-DD]
pnpm --filter @zeeraa/connectors probe-click-id-population
```

**Bringing a newly-connected channel up to 90 days takes three commands**, and
the hourly cron will never do it: that path pulls a two-day spend window and a
watermark-bounded CRM read, by design, because it has 60 seconds.

```bash
pnpm --filter @zeeraa/jobs sync-meta          spartan --days 90
pnpm --filter @zeeraa/jobs backfill-click-ids spartan
pnpm --filter @zeeraa/jobs sync-salesforce    spartan --since 2024-01-01
```

**Adding a click-ID field to the Lead mapping needs two backfills, not one, and
neither happens on a schedule.** This cost an hour on 19 September 2026 and will
cost it again for Microsoft Ads or LinkedIn unless it is read first.

1. **Opportunity grain** — `pnpm --filter @zeeraa/jobs backfill-click-ids
   <slug>`. Walks every converted lead and writes `opportunity_click_ids`. This
   is what gives a *deal* a channel. The hourly incremental runs the same pass
   bounded by its watermark, so it only ever sees the last hour; the nightly
   runner does run it unbounded.

2. **Lead grain** — `pnpm --filter @zeeraa/jobs sync-salesforce <slug> --since
   2024-01-01`. This is the one that is easy to miss. Leads already in the table
   keep whatever `click_id` they were ingested with, and **a sync with no
   `--since` falls back to the last watermark rather than re-reading
   everything** — including the nightly runner, which passes no `since` for
   Salesforce. So the field is in the SELECT, the mapping is right, the sync
   reports `succeeded`, and every historical lead still carries null. Locally
   this was the difference between Meta showing 0 leads and 957.

Symptom to recognise: a channel with spend and funded deals whose **Lead** cell
on the performance table reads 0.

Three things fixed while building it: `test-connection` was wired to Google Ads
only and now dispatches by platform; `spend-to-funded` hardcoded `google_ads`
and now discovers every channel with spend, which is the whole point of the
separation rule; and a Google Ads connector test took "today" in UTC while the
connector takes it in the tenant's zone, so it failed every run between midnight
and 4am UTC.

## Platform pages (19 September 2026)

**Migration 0014 is applied to Neon and the columns are backfilled** (19
September 2026). Applied as `zeeraa_owner` — the URL `options=-c role=…`
parameter on the direct endpoint, which is what postgres.js's `connection`
option silently failed to do for 0013 — so both new indexes are owned by
`zeeraa_owner` like everything else.

| | Google Ads | Meta Ads |
| --- | ---: | ---: |
| `campaigns` with `campaign_type` | **43 of 43** | **19 of 19** |
| types | SEARCH 35 · PERFORMANCE_MAX 7 · DISPLAY 1 | OUTCOME_LEADS 15 · LINK_CLICKS 3 · OUTCOME_SALES 1 |
| `daily_metrics` rows with `reach` | 0 of 405 — not reported | **102 of 102** |
| rows with `clicks_all` | 0 of 405 — not reported | **102 of 102** |
| link clicks / all clicks | 3,608 / — | 5,146 / 8,092 |

The Google nulls are the schema working: null means the platform does not
report it, and the page renders nothing rather than a zero.

The backfill is just the ordinary sync at the full window — `sync-google-ads
spartan --days 90` and `sync-meta spartan --days 90`. Campaign classification
comes from the entity pass, which is never windowed, and `reach` and
`clicks_all` come from the insights pass, so a 90-day re-pull is the whole of
it. No bespoke script.

**An additive migration has to land before the code that reads it.** 0014 was
applied after the commit that selects `campaigns.campaign_type` was pushed, so
any visit to a platform page between the deploy and the migration would have
been a 500 — the column did not exist yet. Closed now, and the ordering is the
lesson: schema first, then deploy.



One page per reporting channel under a **Platforms** section of the rail, whose
items come from the database rather than from a constant — a platform that has
never reported has no entry and its URL 404s.

**The test is whether the platform has reported, not what its connection status
says** (corrected 19 September 2026). The first version filtered on
`status = 'healthy'` and hid Meta in production: `set-credentials` deliberately
does not promote a status, only `test-connection` does, and that had been run
locally but never against Neon — so a connection with working credentials and
102 days of spend behind it sat at `not_configured` and its page vanished. The
status was stale, the data was perfect, and the rail believed the status.

Filtering on health was wrong in two further ways. `degraded` is a working
connection with a stated defect — an ad account reporting in another timezone
still delivers usable data — and `waiting_on_client` means the account is paused
or a token was revoked, which says nothing about the ninety days already
ingested. Both would have lost their page over a caveat. The rule is now one
shared function, `reportingPlatforms`, used by the rail and by the page so they
cannot drift, and the page's own status badge is what reports the connection's
health. Full reasoning in
`docs/brief-amendments.md`, "§12 — a page per connected platform".

Each page is the platform's own reporting — spend, impressions, clicks, CTR,
CPC, CPM, conversions, conversion rate, cost per conversion — then a
full-width rule, then **"What became of it · from Salesforce"**: funded deals
attributed, cost per funded deal with its coverage and range, and this channel's
share of every deal in the period. The rule is there because adjacency invites
division: Meta reports 1,761 conversions and Salesforce attributes it one funded
deal, and those are not two measurements of the same thing.

| | Google Ads | Meta Ads |
| --- | --- | --- |
| Campaign classification | `advertising_channel_type` — "Campaign type" | `objective` — "Objective" |
| Reach / frequency | not reported, so absent | reported, daily |
| Link-click distinction | not reported, so absent | 5,143 link of 8,088 clicks |
| Per-campaign attribution | 6 of 9 deals resolve | **not measurable, by construction** |
| Share of the period's 21 deals | 9 | 1 |

Migration 0014 adds `campaigns.campaign_type`, `daily_metrics.reach` and
`daily_metrics.clicks_all`, all nullable, where **null means the platform does
not report it** rather than zero.

**Reach is stored and never totalled.** Meta deduplicates people across the
range it is asked for, so summing days double-counts anyone who saw an ad twice.
The page renders `Not summable` where a total would go and shows the real daily
figures in the series. A deduplicated window figure needs its own query and its
own storage; it is not a `sum()`.

**A campaign type that did not run shows as a row of zeroes**, not as a missing
row — Spartan's Google account holds 35 Search, 7 Performance Max and 1 Display,
and only Search delivered. There is no Video row because there are no Video
campaigns; drawing one would be inventing a figure.

## GA4 and Search Console (19 September 2026)

**Applied to Neon and backfilled.** Migration 0015 first, then the 90-day pull;
`ga4_metrics` and `search_console_metrics` both carry RLS enabled and FORCE,
both owned by `zeeraa_owner`, and no table in `public` is unprotected.

| | GA4 | Search Console |
| --- | ---: | ---: |
| Window on Neon | 2026-06-22 → 2026-09-18 | 2026-06-22 → **2026-09-16** |
| `total` rows | 89 days, 21,892 sessions | 87 days, 3,306 clicks, 266,969 impressions |
| Breakdown rows | 8,617 landing pages (5,338 values) · 1,122 source/medium (121) | 25,000 pages (2,812) · 25,000 queries (6,052) |
| Impression-weighted position | — | **30.8** (a plain mean would say 30.7) |

Both breakdowns hit Search Console's 25,000-row ceiling, so the tail below the
cut-off is not stored; the pages carry a `Tail cut` badge where that happens.
The daily totals are unaffected.

Both connected, both ingesting, both on the Platforms rail. Full reasoning in
`docs/brief-amendments.md`, "§7 and §9 — GA4 and Search Console".

| | GA4 | Search Console |
| --- | ---: | ---: |
| Window | 2026-06-21 → 2026-09-18 | 2026-06-21 → **2026-09-15** |
| Days reported | 90 | 87 |
| Headline | 21,955 sessions · 20,454 users · 53.7% engaged | 3,257 clicks · 266,737 impressions · CTR 1.2% · position 30.9 |
| Breakdowns | landing page (5,340 values), source/medium (121) | query (6,009), page (2,810) |
| Rows stored | 9,855 | 50,087 |

Search Console's window ends three days short of today because it finalises
late; asking for those days returns nothing, which draws as a collapse rather
than an absence.

**Both read the Google Ads credential.** One OAuth client, one refresh token,
three APIs — so re-issuing that token without `analytics.readonly` and
`webmasters.readonly` breaks both, and `set-credentials spartan google_ads`
is what fixes them.

**Neither can be attributed to a deal, structurally.** The GA4 Data API exposes
no `clientId` or `sessionId` dimension, and Search Console reports queries and
pages and never users. Salesforce's `Session_ID__c` looked like a candidate —
72% of web-originated leads carry it — but its values are UUIDs and GA4's
identifiers are digit-shaped, so it is the form vendor's handle. Both pages end
with a `Not measurable` card saying so instead of an outcomes section.

**Grouped and ungrouped totals disagree in both directions and neither is a
bug**: queries account for 57% of Search Console clicks (privacy filtering),
pages for 102% (a click is attributed per canonical URL), GA4 for 100.4%. The
pages state the comparison and render a ratio above 1 in amber rather than
clamping it.

Migration 0015 adds both tables with the usual RLS treatment. **31 of 31
mutations killed** — three survived the first run because the new isolation
tests were vacuously true, which is exactly what that harness is for.

```bash
pnpm --filter @zeeraa/jobs test-connection spartan ga4|search_console
pnpm --filter @zeeraa/jobs sync-organic     spartan [--days 90] [--only ga4]
pnpm --filter @zeeraa/connectors probe-ga-join
```

## The seed no longer overwrites observed connection health (19 September 2026)

`applyTenantSeed` re-applied its own `status` and `blockedReason` on every run,
which meant re-seeding reset whatever `test-connection` had last observed. Meta
was reset to `not_configured` twice on 19 September — the first time taking its
whole platform page off the rail, because the rail then filtered on health.

Ownership is now split: **the seed owns `config` and `accountIdentifier`; only
`test-connection` writes `status`, `blockedReason`, `blockedSince` and
`lastError`.** The seeded status is an opening position, true before anybody has
reached the account, and it applies on insert only.

All five connections on Neon are `healthy` as of 19 September 2026 — google_ads,
meta, salesforce, ga4, search_console — and a re-seed leaves them that way.

## Blocked

- **All six click-ID fields are mapped Lead → Opportunity (17 September 2026),
  and the mapped route is switched on — but it changes nothing yet.** Salesforce
  lead field mapping copies at the moment of conversion and never
  retrospectively, so all 712 existing opportunities still hold null and
  coverage is unmoved. It starts paying from the next conversion onward. Until
  then `backfillClickIdsFromConvertedLeads` is still doing all the work.
- **Resolved 19 September 2026: `acq_fbclid__c` is read, and Meta is
  connected.** The blocker was never the field — it exists on Lead and
  Opportunity, carries 972 leads and was already in the conversion mapping. It
  was that a Meta channel row would have shown deals against no spend. Ingesting
  Meta spend removed the objection, so the connector and the mapping change
  landed together.
- **`Gbraid__c`, `Wbraid__c` are mapped in Salesforce but empty (0 leads), and
  deliberately not in the connector mapping.** One platform key holds one field
  and Google's `click_view` only ever returns `gclid`, so a gbraid touch could
  never resolve to a campaign.
- **`Lead.TTCLID__c` has no Opportunity counterpart.** TikTok is not in the
  engagement; leave it or create the field deliberately.
- **`Opportunity.csbs__Decline_Reason__c` does not exist**, and is no longer
  mapped. It was kept mapped on purpose while the reason was unmeasured, so
  validation would keep reporting it; the reason is now read from the submission
  object, so the sync reports `succeeded` rather than `partial` forever.
- **Decline reasons are measured at lender grain; a reason per *deal* is not.**
  `Decline_Reason__c` on `csbs__Submission__c` carries them, at rising monthly
  coverage. `Loss_Reason__c` on Opportunity was filled in on every closed-lost
  deal through January 2025 and then abandoned — 0 of 133 in July 2026, 2 of 132
  in August, 1 of 66 in September — and a deal declined by three lenders for
  three reasons has no single reason in the CRM.
- **Revenue bands on Opportunity stay blocked.** `Approved_MCA_Amount__c` and
  `Net_Funding_Amount__c` report 100% populated and hold six real values
  between them. Nothing reads them, and nothing should.
- **MQL is measured, with 43.6% of leads undeterminable.** The bar reads banded
  picklist answers as of 18 September 2026 — 16.5% qualified, 39.8%
  unqualified. What remains blocked is one field: `MIYB_Years_in_Business__c`
  holds the only time-in-business answer for 1,075 leads and its values are
  opaque codes. A decode key from the client converts those leads from
  undeterminable to an answer; guessing at it would not. Tracked as
  `mql_time_in_business_decode`.
- **Call tracking is built and no longer blocked.** Aloware, imported directly.
  What remains is operational rather than a dependency: the webhook
  subscription has to be pointed at
  `/api/webhooks/aloware/spartan` in the Aloware console, and
  `ALOWARE_WEBHOOK_SECRET` set on the deployment, before live calls flow. Until
  then the record ends at the export's last call, 17 September 2026.
- Microsoft Ads, LinkedIn Ads, GA4, Search Console, Semrush: not started.
  `msclkid__c` and `Li_Fat_ID__c` exist on both objects and are mapped, and both
  are populated on **zero** leads — so connecting either would produce spend
  against no attributable deal. That is a forms problem rather than a connector
  one.

## Phase 4 progress

Done:

- **The whole UI, rebuilt against design spec v2.** Not a restyle of the old
  components: the layout shell, the card system, the chart set and every screen
  were written from the shell down.
  - `components/shell` — fixed 240px sidebar, collapsible to 64px and
    off-canvas below `lg`, with the tenant mark, accent stripe, role and
    switcher; a per-page 64px top bar carrying the breadcrumb, title, date
    range, attribution toggle, export, print and "Sync now".
  - `components/ui` — `Card`, `CardHeader`, `EmptyLine`, `Badge`, `Delta`,
    `Progress`, `InfoTip`, `Segmented`, `Button`, `MethodDrawer`. (`Ring` went
    with the delivery view on 21 September 2026; it had one call site.)
  - `components/charts` — `AreaSeries`, `StackedBars`, `RangeBars`,
    `DivergingBars`, `MiniChart`, and `chart-kit` holding the palette, the
    tooltip and the animate-once rule.
  - **The prose is gone.** Every methodology note, caveat and "why this is not
    measured" now lives in an ⓘ, in a `Not measured` badge's tooltip, in the
    "How this is measured" drawer, or as a one-line row in the data-quality
    card. The drawer's contents are also expanded into the print sheet, because
    a QBR printout that carries the figures without their definitions is the
    dispute this product exists to prevent.
- **Two metric config rows added** — `attributed_share` and `applications`, both
  `improvement_direction: 'up'`. A KPI card colours its delta only where
  configuration declares a direction; without a row it renders the sign and the
  arrow in grey. Paid media spend deliberately has no row: spending less is not
  an achievement and spending more is not a failure.
- **CSV export** at `/api/export/{tenant}/{performance|funnel|delivery}`,
  reading the same search params and the same query functions as the screen, so
  it cannot drift from what is displayed. Blocked stages export as an empty cell
  with the reason in a notes column, never as a zero; the unattributed row has
  no spend or cost-per-deal cells at all.
- **"Sync now"** at `/api/sync/{tenant}?platform=`, `zeeraa_admin` only, running
  the same incremental sync the hourly Vercel Cron endpoint runs, waiting for it
  and reporting the real per-platform outcome, duration and remedy.

- **The separation rule is in the UI, not only the arithmetic.** Channel and
  unattributed figures are different TypeScript shapes, so a component cannot
  put them on one row by iterating a list. `UnattributedRow` has no `spend` and
  no `costPerDeal` fields at all. See `docs/brief-amendments.md`, "§9.2 and §12".
- **`CostPerDealFigure` takes a `ChannelCostPerDeal` and has no prop that
  accepts a number**, so a bare cost-per-deal figure is not something a
  developer can render by forgetting something. Coverage and range are on the
  same ground as the value, above the fold.
- **Executive view** renders one channel's cost per funded deal, named as one
  channel's, and states on the band itself that the blended figure is absent and
  why.
- **Monthly performance table** — channels, an explicit unattributed row that is
  not a channel, and a totals row whose cost-per-deal cell is a stated absence.
  Blocked stages render their dependency, never a zero; computed stages are
  marked computed.

- **The schedule runs.** `pnpm --filter @zeeraa/jobs run-scheduled nightly|hourly`
  drives the same sync functions the Inngest handlers call, so cron can run the
  pipeline on any box from tonight without waiting for a deployment.
  `scripts-crontab.example` has the entries. Verified end to end.
- **A real Lead stage.** The funnel now runs Lead → MQL → Application → SQL →
  UW approved → Offer → Funded. Lead counts the inbound `leads` table; what used
  to be called Lead is Application, which is what `opportunity_created` actually
  stamps. A stage declares its grain in `funnel_stages.source`.
- **Funnel view** with a population selector — all sources, each channel, or
  unattributed — where both halves of every rate come from the selected
  population. It also shows the transitions that *can* be measured across a
  blocked stage, rather than leaving the funnel looking severed.
- **Four charts** on the performance screen.

Next, in order:

1. **Finish the Vercel environment.** The hourly cron is the schedule now
   (Inngest is gone); what remains is setting the connection strings, secrets
   and `CRON_SECRET` in the project, and running the first backfill against
   Neon.
2. **The rest of phase 5.** Uploads, versioning and the approval flow are done
   (19 September 2026). What remains is collaboration: the mention picker,
   `@mentions`, asset comments, the activity rail and notifications. Also
   unbuilt: recording a hand-kept count from the UI — the `manual` rows are
   written by hand in SQL today, which is fine for backlinks and prompts but
   will not stay fine.
3. Chase the Opportunity click-ID fields and the decline-reason field.
4. Campaign and keyword-tier drill-down on the performance table. The breakdown
   tab set is on screen with each dimension's blocker stated; campaign is the
   one that is Zeeraa build work rather than a CRM gap.
5. **Reconcile the cost-per-funded-deal target.** The executive hero now shows
   every connected channel side by side rather than one, so there is no north
   star channel left to choose. What is still outstanding is the target: the
   engagement states one number, configuration carries no per-channel target,
   and it currently renders once in the card header rather than against either
   channel. Decide whether it is a blended target, a Google Ads target, or one
   per channel.

## Scheduling: where it really stands (17 September 2026)

The click ledger is **complete and settled**: 90 of 90 days, 2026-06-20 to
2026-09-17, every day `succeeded`. Tonight's run was executed by hand before
pausing, so nothing is outstanding.

**The earlier framing in this file was wrong and is corrected here.** It said
holes start appearing the moment a night is missed. They do not. The backfill
re-pulls a trailing 90-day window and the ledger claims whatever is pending, so
a missed night is picked up by the next run. A day is lost permanently only if
it ages past the 90-day `click_view` window without ever having been fetched —
which now requires the schedule to be dead for months, not for one night. The
urgency was real while the window was uncaptured; it is not any more.

`crontab scripts-crontab.example` is installed and `cron` is running. It was
proved to work rather than assumed: a temporary one-minute entry fired and
executed the job, then was removed.

**It will not fire tonight, and nothing installed on this machine can.** This
Codespace has `idle_timeout_minutes: 30`, so the container suspends half an hour
after the last interaction and a suspended container runs no cron. Verify with:

```bash
gh api "/user/codespaces/$CODESPACE_NAME" --jq .idle_timeout_minutes
```

So the crontab is real and correct and will run whenever the Codespace happens
to be awake at the hour — which is a convenience, not a schedule. The only
unattended schedule is the hourly Vercel Cron entry in `vercel.json`, and it
needs the app deployed with `CRON_SECRET` set (Inngest is gone as of
18 September 2026). Until then: run
`pnpm --filter @zeeraa/jobs run-scheduled nightly` by hand at the end of any
working session, which takes about eight seconds.

## The nightly fan-out was a silent no-op until 17 September 2026

`listGoogleAdsConnections` and `listSalesforceConnections` ran on the ingestion
role with no tenant context. `job_read_connections` is
`tenant_id = app.current_tenant_id()`, so they read zero rows: every scheduled
run would have dispatched nothing, reported success, and let the `click_view`
window age out uningested. Failing closed was correct; asking on the wrong
connection was the bug. They now go through `withMaintenance` on
`getMaintenanceDb()` — orchestration, reading two uuids, with every byte of
actual sync work still scoped by `withJobTenant`. Two tests in
`packages/db/test/job-role.test.ts` hold the line.

## Lead-to-application, now that the two are separate stages

The rate that was hidden while one stage did both jobs, over the trailing 90
days:

| Population | Leads | Applications | Rate |
| --- | ---: | ---: | ---: |
| All sources | 3,748 | 436 | 11.6% |
| Google Ads | 1,091 | 193 | **17.7%** |
| Unattributed | 2,657 | 243 | 9.1% |

Google Ads leads become applications at roughly twice the rate of leads nobody
can attribute. Both halves of each rate come from the same population.

## Operational notes

All idempotent, all taking a tenant slug:

```bash
pnpm --filter @zeeraa/db   set-credentials  spartan google_ads   # or salesforce
pnpm --filter @zeeraa/jobs test-connection  spartan google_ads
pnpm --filter @zeeraa/jobs backfill-clicks  spartan [--days 90] [--max-days N]
pnpm --filter @zeeraa/jobs sync-google-ads  spartan [--days 90]
pnpm --filter @zeeraa/jobs sync-salesforce  spartan [--since YYYY-MM-DD] [--limit N]
pnpm --filter @zeeraa/jobs spend-to-funded  spartan [--days 90]
```

The mutation test **drops and rebuilds the schema it points at**, so it needs a
throwaway database rather than the development one:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zeeraa_mut \
DATABASE_URL_OWNER=postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa_mut \
  npx tsx packages/db/scripts/mutation-test.ts
```

`zeeraa_mut` exists on the local cluster for this. It takes a few minutes — it
re-migrates and runs the whole isolation suite once per mutation. 16 of 16
killed as of 18 September 2026.

Looking at the UI locally: sign in at `/signin` as `admin@zeeraa.com` or
`ceo@spartancapitalgroup.com` with `zeeraa-development-password`, which
`SEED_USERS=yes` sets. Both are flagged to change it, so the first thing either
lands on is `/change-password`. `/api/dev-signin` and `scripts/dev-session.ts`
are gone — they existed because neither sign-in provider worked on a local
machine, and a password works everywhere.

They read `DATABASE_URL_OWNER` and `DATABASE_URL_JOBS`; a local `.env` carrying
the documented defaults from `.env.example` is enough. Platform credentials come
from the shell and stop being environment variables at `set-credentials` — after
that they live encrypted in the connection row, per tenant.

`sync-salesforce` exits non-zero on `partial`, which today means only the
missing decline-reason field. Read the status line before treating it as a
failure.

The Google refresh token is a person's consent, not a service identity. It
breaks when the granting user loses account access, changes their password, or
removes the app, and surfaces as `waiting_on_client` rather than as a failure.
