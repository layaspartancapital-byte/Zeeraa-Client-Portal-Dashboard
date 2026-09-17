# Build brief — Zeeraa client performance platform

You are building a multi-tenant marketing performance and delivery platform for **Zeeraa**, a growth marketing agency. The first client tenant is **Spartan Capital Group**, a merchant cash advance (MCA) and business funding lender.

This is a contractual deliverable. The client's executives read it, and it reports on Zeeraa's own performance. Accuracy, provenance and credibility matter more than visual flourish.

Build it multi-tenant from day one. Spartan is tenant #1, not the only tenant. Nothing client-specific may be hardcoded — client specifics live in configuration rows.

The platform does three jobs:

1. **Prove the economics.** Join ad spend to funded deals and report cost per funded deal.
2. **Report the work.** Live, monthly, platform-by-platform performance across every channel.
3. **Deliver the work.** Zeeraa uploads articles, PR placements, creatives and reports, tags the responsible person at the client with an `@` mention, and that person is notified and can review and approve in place.

Work through the build phases in §16. Do not attempt all of it in one pass. Stop and report after each phase.

---

## 1. The core problem

Ad platforms know **spend and form fills**. Salesforce knows **funded deals and revenue**. Neither can compute the number the client actually cares about: **cost per funded deal**.

The product is the join between those two worlds:

```
click ID → campaign → spend                                (ad platform APIs)
click ID → opportunity → stage timestamps → funded amount  (Salesforce)
```

Everything else is presentation on top of that join. If the join is wrong, nothing else matters.

---

## 2. Stack (decided — do not substitute)

- **Next.js (App Router), TypeScript**, deployed to **Vercel**
- **Postgres** — Neon or Supabase (prefer Neon for branch-per-PR)
- **Drizzle ORM**, SQL migrations checked into the repo
- **Inngest** for all background and ingestion jobs (NOT Vercel cron functions — see §7)
- **Auth.js (NextAuth)** — email magic link plus Google
- **Vercel Blob** for file storage (per-tenant prefixes, signed URLs, no public objects)
- **Resend** for transactional email; **Slack Web API** for channel notifications
- Charts: **Recharts**. Styling: **Tailwind**. Data fetching: **SWR** with revalidate-on-focus.

Development happens in **GitHub Codespaces**. Every secret must behave identically as a Codespaces secret and a Vercel environment variable.

---

## 3. Repository shape

```
/apps/web                 Next.js app (UI + API routes)
/packages/db              Drizzle schema, migrations, RLS policies, seeds
/packages/connectors      One module per platform, behind a shared interface
/packages/jobs            Inngest functions (ingestion, notifications, digests)
/packages/core            Metric definitions, funnel engine, shared types
```

Connectors expose a single interface so adding a platform never touches the app:

```ts
interface Connector {
  key: string;                    // 'google_ads' | 'meta' | ...
  testConnection(conn: Connection): Promise<ConnectionHealth>;
  fetchDailyMetrics(conn: Connection, range: DateRange): Promise<DailyMetricRow[]>;
  fetchEntities?(conn: Connection): Promise<CampaignRow[]>;
}
```

---

## 4. Data model

Every tenant-scoped table carries `tenant_id uuid not null`.

### Tenancy and access
- `tenants` — id, name, slug, timezone (default `America/New_York`), currency, accent_color, created_at
- `users` — id, email, name, avatar_url, title
- `memberships` — user_id, tenant_id, role: `zeeraa_admin` | `zeeraa_member` | `client_admin` | `client_viewer`, notification preferences
  - `zeeraa_*` roles may hold membership in many tenants; client roles exactly one.
- `connections` — tenant_id, platform key, account identifier, **encrypted** credential blob, status, last_synced_at, last_error

### Ad and web data (ingested)
- `ad_accounts` — tenant_id, platform, external_account_id, name, account_timezone, currency
- `campaigns` — tenant_id, platform, external_campaign_id, name, status, product, industry, keyword_tier (last three nullable classification fields)
- `daily_metrics` — tenant_id, platform, date (tenant timezone), campaign_id, impressions, clicks, spend, platform_conversions
  - Unique on (tenant_id, platform, date, campaign_id). **Upsert, never append** — platforms restate.
- `organic_metrics` — tenant_id, date, source (`gsc` | `ga4` | `semrush`), dimension, value
- `ai_visibility` — tenant_id, period, prompt, engine, cited (bool), competitor_cited, position

### CRM data (ingested)
- `leads` — tenant_id, external_id, created_at, click_id, click_id_type, utm_source/medium/campaign/content/term, landing_page, self_reported_revenue, self_reported_time_in_business, industry, state, is_duplicate, duplicate_of
- `opportunities` — tenant_id, external_id, lead_external_id, created_at, current_stage, amount, funded_amount, decline_reason, industry, state
- `stage_events` — tenant_id, opportunity_external_id, stage, occurred_at
  - **Mandatory.** Without per-stage timestamps you can only show snapshots, never cohorts or velocity.
- `attribution` — tenant_id, opportunity_external_id, model (`first_touch` | `last_touch`), platform, campaign_id, click_id
  - Store **both models** for every opportunity from day one. Default the UI to last-touch; expose the model as a toggle.

### Funnel configuration — this is what makes it multi-tenant

Do NOT create columns named `offer_rate` or `funded_deals`.

- `funnel_stages` — tenant_id, position, key, label, is_optimization_target, counts_value
- `tenant_metrics` — tenant_id, key, label, formula_key, target_value, improvement_direction (`up` | `down`), is_north_star, needs_reconciliation

Spartan's stages are Lead → MQL → SQL → UW Approved → Offer → Funded. Another client's might be Lead → Demo → Trial → Subscription. Same engine.

### Delivery commitments
- `deliverable_commitments` — tenant_id, key, label, committed_quantity, period (`monthly` | `quarterly`), unit, requires_client_approval (bool)
- `deliverable_records` — tenant_id, commitment_key, period_start, delivered_quantity, notes, recorded_by_user_id, recorded_at, source (`manual` | `derived_from_assets`)
- `sla_events` — tenant_id, type (`slack_response` | `daily_update` | `weekly_call` | `monthly_report` | `qbr`), occurred_at, response_minutes, notes

### Content and approval workspace (§10)
- `assets` — tenant_id, type, title, description, commitment_key (nullable link to a commitment), period_start, file_key, file_name, mime_type, size_bytes, external_url, status (`draft` | `submitted` | `in_review` | `changes_requested` | `approved` | `published`), uploaded_by_user_id, uploaded_at, published_at, published_url, version, supersedes_asset_id
- `asset_comments` — tenant_id, asset_id, author_user_id, body, created_at, resolved_at
- `mentions` — tenant_id, source_type (`asset` | `comment`), source_id, mentioned_user_id, created_at, read_at
- `notifications` — tenant_id, user_id, type, title, body, link_url, created_at, read_at, delivered_email_at, delivered_slack_at
- `activity_log` — tenant_id, actor_user_id, verb, object_type, object_id, metadata, created_at — append-only, powers the audit trail and the activity feed

### Provenance
- `data_sources` — every fact rendered in the UI resolves to either `api` (with platform and sync timestamp) or `manual` (with user and timestamp).
- `sync_runs` — tenant_id, platform, started_at, finished_at, rows_written, status, error

---

## 5. Tenant isolation

Use **Postgres Row Level Security**, enabled on every tenant-scoped table. Do not rely on application-level `WHERE tenant_id = ?` alone — one forgotten filter leaks one lender's funded volume to a competitor, and Zeeraa's contract explicitly promises client data is never combined with other clients' data.

- Connect as a non-superuser role that RLS applies to.
- Set `app.current_tenant_id` and `app.current_user_role` per request/transaction.
- `zeeraa_admin` may set any tenant; client roles only their own. Cross-tenant reads impossible at the database level.
- File storage follows the same rule: blob keys prefixed `tenant/{tenant_id}/…`, served only through short-lived signed URLs issued after an authorization check. No public objects.
- Write an automated test that attempts a cross-tenant read and asserts zero rows. This must exist before phase 3.

---

## 6. Connectors

Each platform is genuinely different. Do not assume one generic ingestion path.

**Salesforce (JWT bearer flow)** — the most important one.
- Connected App with digital signatures; scopes `api refresh_token offline_access`.
- The integration user must be **pre-authorized** via a permission set on the connected app. JWT skips consent, so an unauthorized profile fails with an unhelpful `user hasn't approved this consumer`.
- Audience differs: `https://login.salesforce.com` (prod) vs `https://test.salesforce.com` (sandbox). Configurable per connection.
- Relax IP restrictions on that profile — Vercel egress IPs are not static.
- **Store the private key base64-encoded in one env var and decode at runtime.** PEM newlines get mangled in env vars; this is the single most common failure.
- Incremental sync on `SystemModstamp`. Bulk API 2.0 for backfill, REST for increments.
- Pull stage transitions from Field History if enabled; otherwise the client's Salesforce admin adds stage-timestamp fields (admin access is available, so assume these can be created).

**Google Ads** — GAQL. Requires a developer token and an MCC/manager account. Quota-limited: batch by date range, never loop per day.

**Meta (Facebook/Instagram)** — the Insights API is **submit-job-then-poll** and can take minutes. This is the strongest single reason ingestion cannot live in a Vercel serverless function. Implement the poll as an Inngest sleep step.

**Microsoft (Bing) Ads** — SOAP reporting: submit, poll for a download URL, fetch and parse a zipped CSV.

**LinkedIn Ads** — Analytics Finder, awkward pivot rules. Read the docs before writing the query builder.

**GA4 and Search Console** — straightforward REST, lowest risk. Build these first to prove the pipeline end to end.

**Semrush** — client-held licence; rank tracking and backlink counts.

**Call tracking** — stub connector against the shared interface; vendor not yet selected.

Every connector must normalize dates into the **tenant timezone at ingest** (never at query time), normalize currency, write a `sync_runs` row, and surface failures as visible connection health rather than silent gaps.

---

## 7. Sync schedule (Inngest, not Vercel cron)

Vercel functions have hard timeouts. Meta's polling and a 90-day first backfill across six platforms will exceed them — it passes in testing and fails on real volume.

- **Hourly** — Salesforce incremental on `SystemModstamp`
- **Nightly, 3am ET** — all ad platforms, trailing **90-day window**, upserted
  - The 90-day re-pull is deliberate: Google and Meta backfill conversions for 30+ days and CRM records change stage retroactively. Re-pulling and upserting makes restatements self-correct. Never append.
- **Weekly** — Search Console, Semrush rankings and backlinks, AI-visibility prompt sweep
- **On demand** — per-tenant "Sync now" for `zeeraa_admin`
- **Every 5 minutes** — notification dispatch queue
- **Daily 8am ET** — unread digest email for anyone with digest preference

Each job: exponential backoff, dead-letter after repeated failure, and a visible run-history page to debug from when a client asks why yesterday's spend is missing.

---

## 8. Metric definitions

Define these **once** in `packages/core` as named, unit-tested functions. Never recompute a metric inline in a component — the same word must mean the same thing on every screen, or the first QBR becomes an argument about arithmetic.

- `total_program_cost` = management fee + paid media spend + separately funded budgets (link building, placements)
- `cost_per_funded_deal` = attributed spend ÷ funded deals in period
- `stage_conversion_rate(n, n+1)` — the generic engine; "offer rate" is one instance of it
- `cost_per_stage(stage)` = attributed spend ÷ count reaching that stage
- `qualified_rate` = leads meeting the tenant's configured minimums ÷ total leads
- `duplicate_rate`, `resubmission_rate` (configurable cool-off window)
- `funded_volume` = sum of funded amount in period
- `stage_velocity` = median days between two stage timestamps
- `sla_compliance` = SLA events meeting commitment ÷ total
- `delivery_completion` = delivered ÷ committed, per commitment, per period

Every metric is sliceable by platform, campaign, keyword tier, product, industry, state and date range. Industry and state slices matter specifically here — approval rates vary sharply by both, and that variance is the engagement's central diagnosis.

---

## 9. Screens

### 9.1 Executive view (default landing)

The only screen with any visual drama, and it spends all of it in one place.

A dark band across the top holds the north-star metric — **cost per funded deal** — set large in the serif, with the target beside it in brass and a 6-period sparkline. Below, on paper, one row of four supporting figures: funded volume, total program cost, funded deals, offer rate. Then one chart: the north-star metric over time with the target drawn as a brass line.

Nothing else. No deliverable counts, no channel breakdown, no activity feed. If the CEO has to scroll, the screen has failed.

It ends with a single line of plain-language interpretation written by the account director for the period. This is the only prose on the screen, and it is what turns numbers into something the client repeats internally.

### 9.2 Monthly performance — all platforms

The workhorse reporting screen, and the one the client opens most after the executive view.

A month selector at the top (and a compare-to-previous toggle). Then a single table, one row per platform — Google Ads, Microsoft Ads, Meta, LinkedIn, YouTube, SEO/organic, AI search, email, direct/referral — with columns: spend, impressions, clicks, CTR, CPC, leads, qualified leads, submissions, UW approved, offers, funded deals, funded volume, cost per funded deal. A totals row at the bottom, computed, not summed naively across attribution models.

Below the table, live charts driven by the same query:
- Spend and funded deals over time, dual series, twelve trailing months
- Cost per funded deal by platform, horizontal bars, target line overlaid
- Funnel-stage composition by platform, stacked bars
- Month-over-month change by platform, explicit signs

Every row expands to campaign level, and campaigns expand to keyword tier. Every chart has a table equivalent behind a toggle. Every view exports to CSV matching the active filters.

All charts read from Postgres and refresh on window focus and on a 60-second interval, with a `data through {timestamp}` line. Charts are live in the sense that they always reflect the latest completed sync — do not build websockets for this.

### 9.3 Funnel view

The dense diagnostic surface. A horizontal stage flow — Lead → MQL → SQL → UW Approved → Offer → Funded — with counts, and **the conversion rate rendered in the gap between stages**, because the gaps are the diagnosis. Optimization-target stages carry a brass underline.

A sticky filter bar (date range, platform, campaign, product, industry, state, attribution model) that **always shows active filters as removable chips**. Users forget a filter is on and then argue about the numbers.

Below: breakdown table, sortable on every column, drill-down by the same dimensions. Decline reasons as a horizontal breakdown, never a pie chart. Stage velocity shown inline in the flow.

### 9.4 Delivery view

Two registers on one screen: committed and delivered.

A two-column ledger — commitment, delivered, period — with a thin progress bar, not a ring. Over-delivery shows as over-delivery rather than capping at 100%; 47 backlinks against a 30–40 target is the point.

SLA block: response-time distribution against the 60-minute commitment, daily-update streak, calls held versus scheduled.

Tone: **no celebratory checkmarks, no confetti.** This is a compliance record; treating delivery as an achievement reads badly to a client paying for it. Neutral, factual, complete.

Internal view adds owner, due date, blocker. Client view shows committed versus delivered only.

### 9.5 Connection health

One row per platform: last successful sync, rows ingested, current state. Failures state what broke and what to do, in the interface's voice, without apologizing.

**"Waiting on client" is a designed state, not an error.** When a dependency outside Zeeraa's control is missing — a Salesforce field, click-ID capture not yet live — it renders in graphite with a plain description of what is needed and since when. A visible dependency is a conversation; a silent gap looks like the agency failed.

---

## 10. Content and approval workspace

This is where Zeeraa hands work over and the client signs off. It replaces email attachments and lost Slack threads, and it is what makes the delivery layer self-populating and evidence-backed.

### Asset types
Article / blog, PR placement, ad creative, landing page design or spec, video script, email flow, report or deck, webinar material, other. Type is a per-tenant configurable list, not an enum in code.

### Upload
Zeeraa staff upload a file (or paste an external URL for a live placement), give it a title and short description, optionally link it to a **deliverable commitment and period** — for example "Articles, guides & case studies — October" — and choose recipients.

- Drag-and-drop with multi-file support; progress per file.
- Direct-to-blob upload via signed URL. Never proxy large files through a serverless function.
- Accept PDF, DOCX, images, video, and common design exports. Enforce a size cap and a MIME allowlist; reject executables.
- Preview inline where possible: images, PDFs and video render in a viewer; other types show a download card.
- **Versioning.** Re-uploading against an existing asset creates version *n+1* and sets `supersedes_asset_id`. The history is visible; old versions are never deleted.

### @ mentions
The description and every comment support `@` mention with autocomplete.

- The picker lists **only members of the current tenant** — the client's own people and the Zeeraa staff assigned to that tenant. It can never surface a user from another tenant.
- Mentions are stored as structured references (`mentions` rows), not parsed out of text at render time, so a renamed user still resolves.
- Mentioning someone creates a notification and, per their preference, an email and a Slack message.
- Rendered mentions are a distinct chip and link to that person's profile card.

### Review and approval
Statuses: `draft` → `submitted` → `in_review` → (`changes_requested` → back to submitted) → `approved` → `published`.

- Only `client_admin` can approve or request changes. `client_viewer` can comment.
- A comment thread lives on every asset; comments resolve individually.
- Requesting changes requires a reason — an empty rejection creates a Slack conversation, which defeats the purpose.
- Approved assets record who approved and when. This is the audit trail that settles "we never signed off on that."

### The loop back to delivery
When an asset linked to a commitment reaches `published`, it increments that commitment's `delivered_quantity` for the period automatically, with `source = 'derived_from_assets'`, and the asset becomes the evidence behind the number.

This is the point of the whole module: the delivery ledger stops being a self-reported count and becomes a list of artifacts the client can open. Manual entry remains available for commitments with no artifact (calls held, prompts tracked), and those are visually marked as hand-entered per §12.

### Workspace screen
Two views of the same data: a board grouped by status, and a table with filters for type, period, commitment, status and person. A per-user "needs your attention" filter surfaces anything where they are mentioned, assigned, or blocking an approval. Activity feed on the right, drawn from `activity_log`.

---

## 11. Notifications

Three channels, one queue.

- **In-app** — a bell with unread count, a panel grouped by tenant for Zeeraa staff. Always on.
- **Email** (Resend) — per-user preference: instant, daily digest at 8am ET, or off. Emails carry the asset title, who mentioned them, the comment excerpt, and a deep link. Plain and legible; no marketing styling.
- **Slack** — Zeeraa's engagement runs in a shared Slack channel, so this matters. A Slack app per tenant connection, posting to the configured channel, with the mentioned person's Slack user ID mapped on their profile so the Slack message genuinely pings them. If a Slack user ID is not mapped, fall back to email and show the unmapped state in settings rather than failing silently.

Notification types: mentioned in an asset or comment, asset submitted for review, changes requested, asset approved, sync failure (Zeeraa roles only), monthly report ready, SLA breach risk (Zeeraa roles only).

Rules: never notify someone about their own action. Batch rapid-fire mentions on the same asset into one message. Every notification deep-links to the exact asset and comment. Mark-as-read on view.

---

## 12. Design

### Direction

The proposal's identity is black, gold and a high-contrast serif. That is right for a PDF and wrong for a tool someone reads tables in for an hour — gold on black fails contrast at data sizes and causes strain over long sessions.

**Resolution: a light, ledger-like workspace. Gold becomes a signal, not a surface.** It marks targets, the north-star metric and the active tenant. Nothing else. The brand is carried by the typography and one dark band on the executive view, not by painting every panel.

```
--paper        #FAFAF9   page background
--surface      #FFFFFF   tables, panels
--ink          #14161A   primary text, figures
--graphite     #5A6169   labels, secondary text
--rule         #E4E3DF   borders, dividers, table lines
--night        #101214   executive band, print header

--brass        #8A6B1F   target lines, north-star accent (text-safe)
--brass-bright #C9A227   fills and indicators on dark only — never text on light

--shortfall    #9E3B2E   below target (brick, not alarm red)
--ahead        #2F6B4F   above target
--provisional  #B8B5AE   unsettled / restating data
```

Positive and negative states must **never** be carried by color alone — always pair with a sign, arrow or label. Clients print this, and some are colorblind.

### Type

- **Display / north-star figures** — a high-contrast serif, `Newsreader` or `Source Serif 4`. Used *only* for the north-star number and the funded-volume figure. It works because it appears twice, not everywhere.
- **Interface and data** — `IBM Plex Sans`, chosen for genuine tabular figures. Not Inter.
- **Identifiers, click IDs, campaign codes** — `IBM Plex Mono`, small.

`font-variant-numeric: tabular-nums` on every numeric cell, no exceptions. Sentence case throughout. No tracked-out all-caps eyebrow labels. Never accent a single word of a heading in a different color or weight.

### Structure

Do **not** build this as a grid of identical rounded cards with soft grey shadows. That is the default SaaS kit and it flattens hierarchy, which is the one thing this app cannot afford.

Hairline rules and whitespace do the grouping. One border radius (4px), on interactive elements only. Panels are defined by a rule and spacing, not a shadow. The only elevated surface in the app is a modal.

Motion: state changes only — a filter applying, a row expanding, a sync completing, an upload progressing. No entrance animations, no hover lift on panels. Respect `prefers-reduced-motion`.

### Provenance as a visual system

The most important design requirement here. A client is reading numbers the agency produced about the agency's own performance. The moment a figure looks hand-typed, every figure loses authority.

**Machine-pulled** — normal ink, a hairline platform mark, `data through {timestamp}` in the panel header. Reads as neutral fact.

**Hand-entered** — a small pencil indicator on the figure, with who recorded it and when in the panel footer. Not hidden, not apologetic, just labelled. Hover or tap reveals the audit entry.

**Derived from an approved asset** — a third register: the figure links to the artifacts behind it. This is the strongest form of evidence in the app and should read that way.

A number with no resolvable source never renders. Render an explicit empty state instead.

**Provisional data.** The trailing 7 days of any spend or conversion series is drawn in `--provisional` — dashed line, hatched fill, or reduced opacity — with a legend entry reading "still settling." Never quietly show a number you know will change.

### Tenant identity

Zeeraa staff will have two competing lenders open in adjacent tabs. Misreading one for the other is the worst failure this app can have.

- A persistent 3px accent stripe along the top of the viewport in the tenant's assigned color.
- Tenant name top-left in the app chrome at all times, never behind a menu.
- The switcher requires two actions: open, then select. No hover-to-switch, no keyboard shortcut.
- Browser tab title leads with the tenant name.
- Client roles never see the switcher.

### Numbers

- Currency: no decimals above $1,000 (`$67,638`); two below (`$19.79`). Never mixed within a column.
- Rates: one decimal (`14.7%`), with the denominator on hover or in a sub-label — `14.7% · 31 of 211`.
- Right-align numerics, left-align text, never center numbers.
- **Never render a raw platform float.** Google Ads reports `622.86` conversions because of fractional attribution; round for display and explain the fraction in the metric definition, or the client will think the dashboard is broken.
- Every metric has a one-click definition: plain-English sentence, formula, source. Because "CPA" means two different things in this engagement's own paperwork, this is dispute prevention, not polish.
- **Every figure carries a referent** — value, comparison (vs target / prior period / baseline), and direction with an explicit sign. Never a bare number.
- Direction is not universal: cost per funded deal falling is good, funded volume falling is bad. Derive good-versus-bad from each metric's `improvement_direction`. Never hardcode "up is green."

### Charts

- One chart type per job: **line** for time series, **horizontal bar** for category comparison, **stacked bar** for composition over time. No pie charts, no donuts, no dual-axis, no area fills under lines.
- Target lines in brass, dashed, labelled at the right edge.
- Direct-label series at the line end rather than using a legend where space allows.
- Zero-baseline on cost and rate charts unless genuinely warranted, and say so when not.
- Every chart has an accessible table equivalent behind a toggle.
- Empty charts state what would fill them and what is missing — never render an empty plot area.

### Non-negotiables

- Responsive to 375px. The CEO will open this on a phone in a meeting; the executive view must be fully legible there. Tables scroll horizontally inside their own container; the page body never does.
- Visible keyboard focus everywhere; full keyboard navigation of tables, filters and the mention picker.
- WCAG AA contrast minimum on all text.
- **A print stylesheet.** This gets printed for QBRs: drop navigation and chrome, set tenant name, period and generation timestamp in the header, expand all tables, render charts legibly in grayscale.
- CSV export on every table, matching active filters.
- Loading states show the shape of what is coming (skeleton rows matching the real table), never a spinner on an empty page.
- Errors explain what happened and the next action. They do not apologize and are never vague.

### What to avoid

- A grid of identical rounded cards with `rgba(0,0,0,.1)` shadows
- Gradient washes as decoration
- Tracked-out all-caps eyebrow labels above every heading
- `01 / 02 / 03` markers on things that are not sequences (funnel stages are; the deliverables list is not)
- Emoji or an icon per metric
- An icon-only sidebar with no labels
- Celebration states on a compliance report
- Any metric rendered without a comparison referent

---

## 13. Seeding tenant #1 — Spartan Capital Group

Seed as **configuration rows, not hardcoded values.**

**Funnel stages:** Lead → MQL → SQL → UW Approved → Offer → Funded. Optimization targets: UW Approved, Offer, Funded. North star: cost per funded deal (`improvement_direction: down`).

**Qualification minimums** (drive `qualified_rate`): monthly revenue ≥ $10,000, time in business ≥ 12 months. Duplicate cool-off: 15 days.

**Baseline snapshot** (Google Ads search, 1 Jun – 31 Aug 2026 — store as a labelled baseline, not live data): spend $67,637.68; 3,417 clicks / 59,940 impressions; CPC $19.79; 622.86 conversions at 18.23%; cost per conversion $108.59; blended offer rate 14.7%.

**Monthly commitments:** 20 ad creatives; 2 landing pages; 8 articles/guides/case studies; 30–40 quality backlinks; 2–3 concurrent A/B tests; 50 GEO/AI prompts tracked; 1 CEO thought-leadership pitch; 1 email flow plus 1 newsletter. **Quarterly:** 1 produced webinar; 1 QBR.

Mark `requires_client_approval = true` on articles, landing pages, creatives, CEO pitches and email flows — these are the ones that flow through the approval workspace.

**SLA:** team available 9am–3pm ET Mon–Fri (US federal holidays excluded); Slack response within 60 minutes in working hours; daily progress update; weekly strategy call; monthly report.

**Funded-volume milestone ladder:** $30K → $100K → $200K → $400K → $750K → $1M → $1.5M → $2M+ monthly.

**Targets are editable config, and several proposal figures conflict.** Store these with `needs_reconciliation = true` and surface them in an admin screen rather than rendering them as committed progress bars:
- CPA stated as $2,000 today → $1,000 target, alongside a Google Ads cost per conversion of $108.59 — different definitions of the same word
- Cost per funded deal $8,000 → $4,500 within 30 days, alongside a milestone ladder that *starts* at $30K funded volume, alongside a month-1 funded volume target of $100–150K
- Owned database described as both 1M records and 100,000 records
- Backlinks stated as both 30–40/month and 30–50 in the first 30 days

Never bake any of these into code as constants.

---

## 14. Environment variables

App-level: `DATABASE_URL`, `ENCRYPTION_KEY`, `SF_CLIENT_ID`, `SF_PRIVATE_KEY_BASE64`, `SF_LOGIN_URL`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `BLOB_READ_WRITE_TOKEN`, `RESEND_API_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`.

Per-tenant OAuth tokens and Slack tokens live **encrypted in the `connections` table**, never in env vars — otherwise every new client requires a redeploy.

---

## 15. Build phases

Stop and report after each: what works, what is stubbed, what is blocked.

1. **Foundation** — repo structure, Drizzle schema, migrations, RLS policies, the cross-tenant leak test, auth, roles, tenant switcher, app shell with tenant identity. No data yet.
2. **Salesforce** — JWT connection, incremental sync, leads / opportunities / stage_events, both attribution models. Prove the click ID survives Lead→Opportunity conversion; if the field mapping is missing, say so loudly rather than silently dropping attribution.
3. **The join and the executive view** — Google Ads connector, the spend↔funded join, metric definitions in `packages/core` with unit tests, provenance system, executive screen. **This milestone proves the product works.**
4. **Monthly performance and funnel** — the all-platforms monthly table, live charts, full slicing, decline reasons, velocity.
5. **Content and approval workspace** — uploads, versioning, `@` mentions, comments, approval flow, activity log, the loop into delivery counts.
6. **Notifications** — in-app, email, Slack; preferences; digest job.
7. **Remaining connectors** — GA4 and Search Console first (simplest), then Microsoft, LinkedIn, Semrush, Meta last (hardest).
8. **Hardening** — connection health, sync history, CSV export, print stylesheet, error and empty states, and a second tenant seeded with a deliberately different funnel shape to prove the abstraction holds.

---

## 16. Guardrails

- No client-specific logic in code. If it is Spartan-specific, it is a config row.
- Never append to `daily_metrics`. Always upsert.
- Never render a number without a resolvable source.
- Never rely on application-level tenant filtering alone.
- Never expose a blob URL that is not signed and authorization-checked.
- The mention picker may never surface a user outside the current tenant.
- If a data dependency is missing — a Salesforce field, click IDs not being captured — surface it as an explicit blocked state in the UI. A visible dependency is a conversation; a silent gap looks like a failure.
