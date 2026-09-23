import type { TenantSeed } from './types';
import leadExclusion from './lead-exclusion.spartan.json' with { type: 'json' };

/**
 * Spartan Capital Group — tenant #1.
 *
 * Every number below is a configuration row. Nothing here is referenced by key
 * anywhere in application code: the funnel engine reads `funnelStages`, the
 * metric engine reads `tenantMetrics.formulaKey`, and a second tenant with a
 * completely different shape runs the same code paths.
 *
 * Where the source material contradicts itself, the conflict is recorded in
 * `reconciliationItems` and the affected metric is flagged
 * `needsReconciliation` rather than rendered as committed progress (§13).
 */
export const spartan: TenantSeed = {
  tenant: {
    name: 'Spartan Capital Group',
    slug: 'spartan',
    timezone: 'America/New_York',
    currency: 'USD',
    // Distinct from --brass so the tenant stripe never reads as a target marker.
    accentColor: '#2F5D8C',
  },

  funnelStages: [
    /**
     * Counted from the `leads` table, not from stage events.
     *
     * Until 17 September 2026 the first stage was the opportunity-created
     * timestamp wearing the label "Lead", which put 436 in a column beside a
     * CRM holding 7,202 inbound leads. The two are genuinely different things —
     * most leads never become an opportunity, and the ratio between them is the
     * single most useful rate in this funnel — so they are two stages.
     *
     * `leads` is already the inbound population: cold outreach is excluded at
     * ingest, so nothing here needs to re-filter it.
     */
    { position: 1, key: 'lead', label: 'Lead', source: 'leads' },
    /**
     * Lead grain, narrowed to the leads that pass the bar.
     *
     * Not `stage_events`: an MQL event is stamped against an opportunity, so
     * counting the stage that way counts only the qualified leads that went on
     * to convert — 26 of 649 in the trailing 90 days. That number is real, but
     * it is not the MQL count, and putting it over every lead produced a
     * qualification rate of 0.7% against a measured 17.0%.
     */
    { position: 2, key: 'mql', label: 'MQL', source: 'qualified_leads' },
    /**
     * What used to be called Lead. An application is an opportunity record
     * existing at all, which is what `opportunity_created` actually stamps.
     */
    { position: 3, key: 'application', label: 'Application' },
    { position: 4, key: 'sql', label: 'SQL' },
    { position: 5, key: 'uw_approved', label: 'UW approved', isOptimizationTarget: true },
    { position: 6, key: 'offer', label: 'Offer', isOptimizationTarget: true },
    { position: 7, key: 'funded', label: 'Funded', isOptimizationTarget: true, countsValue: true },
  ],

  metrics: [
    {
      key: 'cost_per_funded_deal',
      label: 'Cost per funded deal',
      formulaKey: 'cost_per_funded_deal',
      improvementDirection: 'down',
      isNorthStar: true,
      // Settled 23 September 2026: the M1–M8 engagement model is Zeeraa's
      // committed target sheet and governs every target. The target is the
      // ramp month's row in `engagement_targets`, not one number for all time,
      // so there is no single `targetValue` to hold here.
      definition:
        'Attributed media spend and fees in the period divided by the number of ' +
        'deals that reached the Funded stage in the same period.',
    },
    {
      key: 'funded_volume',
      label: 'Funded volume',
      formulaKey: 'funded_volume',
      improvementDirection: 'up',
      // Settled by the engagement model, like cost per funded deal: the target
      // is the ramp month's Funded Amount. Renewals are excluded.
      definition:
        'Sum of the funded amount (csbs__Funded__c) on every non-renewal deal that ' +
        'reached Funded in the period.',
    },
    {
      key: 'funded_deals',
      label: 'Funded deals',
      formulaKey: 'stage_count',
      formulaArgs: { stage: 'funded' },
      improvementDirection: 'up',
      definition: 'Count of deals reaching the Funded stage in the period.',
    },
    {
      key: 'total_program_cost',
      label: 'Total program cost',
      formulaKey: 'total_program_cost',
      // Cost falling is not automatically good, but the direction field must
      // hold one value; the executive view pairs it with funded volume rather
      // than judging it alone.
      improvementDirection: 'down',
      definition:
        'Management fee plus paid media spend plus separately funded budgets ' +
        '(link building, placements) in the period.',
    },
    {
      /**
       * Configuration, not code. The executive view colours a delta green or
       * red only where a metric declares which way is better, so a KPI card
       * without a row here renders its change with a sign and an arrow and no
       * colour rather than having a component guess.
       */
      key: 'attributed_share',
      label: 'Attributed share',
      formulaKey: 'attributed_share',
      formulaArgs: { stage: 'funded' },
      improvementDirection: 'up',
      definition:
        'Deals reaching the value stage that the platform can attribute to a ' +
        'connected channel, over every deal reaching it from any source. A ' +
        'measure of coverage, not of performance.',
    },
    {
      key: 'applications',
      label: 'Applications',
      formulaKey: 'stage_count',
      formulaArgs: { stage: 'application' },
      improvementDirection: 'up',
      definition: 'Count of opportunities reaching the Application stage in the period.',
    },
    {
      key: 'offer_rate',
      label: 'Offer rate',
      formulaKey: 'stage_conversion_rate',
      formulaArgs: { from: 'uw_approved', to: 'offer' },
      improvementDirection: 'up',
      definition:
        'Deals reaching Offer divided by deals reaching UW approved. One instance ' +
        'of the generic stage conversion rate, not a column in the database.',
    },
    {
      /*
       * The replacement for offer_rate, at the grain the decision happens.
       *
       * `formulaKey` is deliberately not `stage_conversion_rate`: this is not a
       * transition between two funnel stages, it is one population of lender
       * answers divided by the decided part of itself. Giving it the stage
       * formula would invite the same cross-grain division that made the
       * metric it replaces meaningless.
       */
      key: 'lender_offer_rate',
      label: 'Lender offer rate',
      formulaKey: 'submission_offer_rate',
      formulaArgs: {},
      improvementDirection: 'up',
      definition:
        'Submissions a lender offered on, over the submissions a lender has ' +
        'decided — offers plus declines. Submissions nobody has answered are ' +
        'excluded and stated separately, because a lender that has not replied ' +
        'has not declined.',
    },
    {
      key: 'cpa',
      label: 'CPA · cost per approval',
      formulaKey: 'cost_per_stage',
      // Settled 23 September 2026 by the engagement model, which governs: its
      // CPA is budget ÷ approvals in all eight months, so the "A" is an
      // underwriting approval — not an SQL, and not the platform's conversion.
      formulaArgs: { stage: 'uw_approved' },
      improvementDirection: 'down',
      definition:
        'Attributed spend divided by the deals reaching UW approved, as the engagement ' +
        'model defines it.',
    },
    {
      key: 'qualified_rate',
      label: 'Qualified rate',
      formulaKey: 'qualified_rate',
      improvementDirection: 'up',
      definition:
        'Leads meeting the configured minimums (monthly revenue and time in ' +
        'business) divided by total leads.',
    },
    {
      key: 'duplicate_rate',
      label: 'Duplicate rate',
      formulaKey: 'duplicate_rate',
      improvementDirection: 'down',
      definition: 'Leads flagged as duplicates divided by total leads in the period.',
    },
    {
      key: 'resubmission_rate',
      label: 'Resubmission rate',
      formulaKey: 'resubmission_rate',
      improvementDirection: 'down',
      definition:
        'Leads resubmitting within the configured cool-off window divided by total leads.',
    },
    {
      key: 'stage_velocity_lead_to_funded',
      label: 'Lead to funded velocity',
      formulaKey: 'stage_velocity',
      formulaArgs: { from: 'lead', to: 'funded' },
      improvementDirection: 'down',
      definition: 'Median days between the Lead and Funded stage timestamps.',
    },
  ],

  config: [
    {
      key: 'engagement_start_month',
      description:
        'The calendar month the engagement begins, as YYYY-MM. M1 of the ' +
        'ramp in `engagement_targets` lands on it, and every later month ' +
        'follows from it; the six months before it are drawn as the baseline. ' +
        'October 2026, recorded 23 September 2026. It is not a date to guess: ' +
        'assuming the engagement began when ingestion did would have put M1 in ' +
        'June 2026 and reported the client as behind a curve nobody started. ' +
        'Change it with scripts/set-engagement-start.ts, not db:seed.',
      value: { month: '2026-10' },
    },
    {
      key: 'min_rate_denominator',
      description:
        'Two floors on the population behind a rate, because they are two ' +
        'different judgements. `minimum` is the smallest denominator a rate may ' +
        'be *compared* against: below it the figure still renders and the delta ' +
        'does not, because a comparison needs both sides to mean something. ' +
        'Unblocking UW approved produced an offer rate of 58.8% (67 of 114) ' +
        'against a previous period of 200% (2 of 1), and the resulting ' +
        '"−70.6%, a regression" was a statement about one opportunity. ' +
        '`render` is the smallest denominator the figure itself may be drawn ' +
        'over, and it is far lower: the executive screen has to work at a ' +
        'one-day range, where a cost per funded deal over one or two deals ' +
        'measures the sample and not the channel. Three, so that nine ' +
        'attributed deals over ninety days — the real figure this product ' +
        'exists to report — is never withheld by a floor meant for deltas.',
      value: { minimum: 10, render: 3 },
    },
    {
      key: 'aloware',
      description:
        'How to read an Aloware call export, and what counts as connected. ' +
        'Merged over the connector defaults, so only the differences live ' +
        'here. connectedMinTalkSeconds is the judgement: the vendor marks ' +
        '26,311 of 28,863 calls `completed`, and 13,376 of those talked for ' +
        'under ten seconds — answering machines and immediate hang-ups. ' +
        'Treating `completed` alone as a conversation reports a 91% connect ' +
        'rate on outbound dialling. At 30s, 3,503 calls are connected; at ' +
        '10s, 9,979; at 1s, 23,355. The sensitivity is why the number is a ' +
        'row and is shown beside the figure it decides.',
      /*
       * `webhook` is deliberately absent here.
       *
       * The Zapier trigger's field names, its allow-listed events and its
       * completed statuses are facts about Aloware's product rather than about
       * this client, so they live in `DEFAULT_ALOWARE_MAPPING` and are merged
       * in. A tenant whose subscription is configured differently can override
       * the whole `webhook` block from this row — the merge is shallow, so an
       * override replaces it rather than patching it.
       */
      value: { connectedMinTalkSeconds: 30 },
    },
    {
      key: 'max_rate_leakage',
      description:
        'How much of a later funnel stage may have skipped the earlier one ' +
        'before their ratio stops being a conversion rate. Measured per ' +
        'transition against the stage events rather than assumed from the ' +
        'stage order, because the order is a drawing and the events are the ' +
        'record. In this org: 1 of 114 approved deals has no underwriting ' +
        'timestamp (0.9%, inside tolerance, rate shown with the exclusion ' +
        'stated), 10 of 67 offers have no approval at all (14.9%) and 9 of 21 ' +
        'funded deals have no recorded offer (42.9%) — both suppressed, ' +
        'because a numerator that is a seventh strangers is not measuring the ' +
        'transition it is named after.',
      value: { share: 0.02 },
    },
    {
      key: 'mql_bar',
      description:
        'Spartan\u2019s marketing-qualification bar. Both conditions together. Also ' +
        'derives the MQL stage, which has no timestamp field in Salesforce: a ' +
        'qualifying lead reached MQL when it was created. The two revenue ' +
        'figures are one threshold at two periods \u2014 $10,000 monthly is ' +
        '$120,000 annual \u2014 so records are normalised to a monthly basis before ' +
        'comparison, preferring the monthly figure where both are present.',
      value: {
        minMonthsInBusiness: 12,
        minMonthlyRevenue: 10000,
        // Past this spread between the monthly and annual figures, the record is
        // flagged: it is almost always a data-entry error rather than a real
        // difference, most often a monthly figure typed into the annual field.
        revenueDisagreementTolerance: 0.1,
      },
    },
    {
      key: 'lead_exclusion',
      description:
        'Which Lead records this platform may ingest at all. Spartan runs a ' +
        'cold-outreach workstream out of the same org, and the two populations ' +
        'are opposites \u2014 the cold list carries appended firmographics and no ' +
        'attribution, inbound web leads the reverse \u2014 so averaging them makes ' +
        'every rate describe a population that does not exist. Applied in the ' +
        'SOQL WHERE clause, so an excluded record is never read. Read-side only: ' +
        'nothing in Salesforce is written, modified or deleted. A lead matching ' +
        'no rule must still carry an inbound signal to be ingested; the residue ' +
        'is counted as unclassified on every sync run rather than assumed ' +
        'inbound. See docs/brief-amendments.md \u00a76.',
      value: leadExclusion,
    },
    {
      key: 'stage_exclusions',
      description:
        'Stage events that are real but are not counted. Renewal-type deals ' +
        '(Renewal, Renewals, Addon, Win Back, Winback, Existing Business) ' +
        'are existing merchants, not deals marketing produced, so they are ' +
        'excluded from every funnel stage, every rate and every cost — and a ' +
        'lead that converted into one is excluded from Lead and MQL. The client ' +
        'decided the list and the scope on 23 September 2026. ' +
        'Matched case-insensitively on the opportunity Type field; the event is ' +
        'kept with its reason so the exclusion can be audited.',
      value: {
        rules: [
          {
            reason: 'renewal',
            dealTypes: [
              'Renewal',
              'Renewals',
              'Addon',
              'Win Back',
              'Winback',
              'Existing Business',
            ],
            // Every stage, lead-grain included: renewals are not marketing's
            // anywhere (client decision, 23 September 2026).
            stages: ['*'],
          },
        ],
      },
    },
    {
      key: 'stage_corrections',
      description:
        'Stage dates corrected by hand over what the CRM records. Month only ' +
        'where the day cannot be established; a corrected event is neither ' +
        'observed nor computed and renders as corrected.',
      value: {
        corrections: [
          {
            opportunity: '006Vr00000eOpyPIAS',
            stage: 'funded',
            month: '2026-05',
            source:
              'Recorded 23 September 2026 on the client\u2019s instruction. Onu Ventures ' +
              '($10,000) funded in May 2026; the day is unknown. Salesforce stamps ' +
              '1 September because the rep could only move the stage after ' +
              'backfilling a submission, an offer and a contract in the seven ' +
              'minutes before (Description: \u201cWont let me update status. Funded ' +
              'by me - 10k\u201d). The 13 May on the funded-date field is a copy of ' +
              'CloseDate, the creation date. Last merchant contact 28 May.',
          },
        ],
      },
    },
    {
      key: 'duplicate_cooloff_days',
      description: 'A repeat submission inside this window counts as a resubmission.',
      value: { days: 15 },
    },
    {
      key: 'working_hours',
      description: 'SLA clock. US federal holidays excluded.',
      value: {
        timezone: 'America/New_York',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '09:00',
        end: '15:00',
        excludeUsFederalHolidays: true,
      },
    },
    {
      /*
       * Not `working_hours`, above. That row is Zeeraa's own availability to
       * the client under the brief's SLA (9–3 ET); this is when Spartan's desk
       * answers leads, which is the clock speed to lead is held to.
       */
      key: 'lead_response_hours',
      description:
        "The clock speed to lead and every response-time figure run on: the " +
        "desk's hours, 9am–6pm Eastern, Monday to Friday. A lead that arrives " +
        'outside hours starts its clock at the next opening; one called before ' +
        'the opening is a zero wait. Holidays are closed days, YYYY-MM-DD in ' +
        'this timezone — none recorded yet. The 24/7 median is still shown ' +
        'beside the figure.',
      value: {
        timezone: 'America/New_York',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        open: '09:00',
        close: '18:00',
        holidays: [],
      },
    },
    {
      key: 'attribution_default_model',
      description: 'The UI default. The other model stays available as a toggle.',
      value: { model: 'last_touch' },
    },
    {
      key: 'provisional_window_days',
      description: 'Trailing days drawn as still settling on any spend or conversion series.',
      value: { days: 7 },
    },
    {
      key: 'click_id_platform_priority',
      description:
        'Which click ID wins when a lead arrives carrying several. Deterministic ' +
        'by configuration rather than by whichever field is read first.',
      value: { priority: ['google_ads', 'microsoft_ads', 'meta', 'linkedin_ads'] },
    },
    {
      key: 'decline_reason_sparse_threshold',
      description:
        'Below this recorded share, the decline breakdown states that the ' +
        'composition is not representative. Spartan currently records 16.4%.',
      value: { threshold: 0.6 },
    },
  ],

  baselines: [
    {
      key: 'google_ads_search_jun_aug_2026',
      label: 'Google Ads search, 1 Jun – 31 Aug 2026',
      platform: 'google_ads',
      periodStart: '2026-06-01',
      periodEnd: '2026-08-31',
      note:
        'Client-supplied snapshot from before the engagement. Stored as a labelled ' +
        'baseline, never as live data, so no connector can appear to have produced it.',
      metrics: {
        spend: 67637.68,
        clicks: 3417,
        impressions: 59940,
        cpc: 19.79,
        conversions: 622.86,
        conversionRate: 0.1823,
        costPerConversion: 108.59,
        blendedOfferRate: 0.147,
      },
    },
  ],

  milestones: {
    metricKey: 'funded_volume',
    ladder: [30000, 100000, 200000, 400000, 750000, 1000000, 1500000, 2000000],
  },

  /**
   * Zeeraa's engagement model, complete: eight months of budget, CPA,
   * approvals, cost per funded deal and funded deals. Google Ads only — Meta
   * carries no target and must not inherit one.
   *
   * **Transcribed from `SpartanCapital Google Ads Budget Projection for 8
   * Months(Sheet1).csv`**, which lives in `data/private/` and is gitignored.
   * The figures are written out here rather than parsed from the file at seed
   * time for two reasons: a fresh checkout and CI have no `data/private/`, so a
   * parser would make the seed unrunnable where the file is absent; and these
   * are contract figures, which belong in a diff a reviewer can read.
   *
   * The cost-per-funded-deal curve is 4000 × 0.92 × 0.95^(n−2) from M2, and the
   * model's stated figures are the rounding of it. Written as the stated
   * figures, because the contract states numbers and a formula would be this
   * codebase's reconstruction of them.
   *
   * **`approvals` and `fundedDeals` are fractions on purpose.** 7.5 funded
   * deals in M1 is a projection, not a count, and the halves are load-bearing:
   * the model is internally consistent only with them. See migration 0021, and
   * `engagement-model.test.ts`, which re-derives both ratios from these rows
   * and fails on a transcription slip.
   *
   * **The model's `cpa` is budget ÷ approvals — cost per *approval*.** Every
   * month reproduces it: $30,000 ÷ 40 = $750, $316,241 ÷ 603.8 = $524. It is
   * not cost per application, not cost per SQL, and not the Google Ads
   * platform's own cost per conversion, all of which are also called CPA
   * somewhere in this engagement. The `cpa_definition` reconciliation row
   * carries the disagreement; this column is the ramp's own definition and is
   * unambiguous because the model computes it from its own two columns.
   *
   * **`fundedAmount` is the model's Funded Amount column**, loaded 23
   * September 2026 once the model was confirmed as the committed target sheet.
   * From M2 it is funded deals × the model's $20,000 minimum deal size,
   * unrounded (11.4 × 20,000 is 228,000; the model says 228,261). M1's $80,000
   * is the model's own figure and does not follow the rule — its deal-size
   * column reads 0 — so it is transcribed, not derived.
   */
  engagementTargets: [
    // Month  Budget      CPA   Approvals    CPF   Funded   Funded amount
    { platform: 'google_ads', monthIndex: 1, budget: 30000, cpa: 750, approvals: 40, costPerFundedDeal: 4000, fundedDeals: 7.5, fundedAmount: 80000 },
    { platform: 'google_ads', monthIndex: 2, budget: 42000, cpa: 713, approvals: 58.9, costPerFundedDeal: 3680, fundedDeals: 11.4, fundedAmount: 228261 },
    { platform: 'google_ads', monthIndex: 3, budget: 58800, cpa: 677, approvals: 86.9, costPerFundedDeal: 3496, fundedDeals: 16.8, fundedAmount: 336384 },
    { platform: 'google_ads', monthIndex: 4, budget: 82320, cpa: 643, approvals: 128, costPerFundedDeal: 3321, fundedDeals: 24.8, fundedAmount: 495724 },
    { platform: 'google_ads', monthIndex: 5, budget: 115248, cpa: 611, approvals: 188.7, costPerFundedDeal: 3155, fundedDeals: 36.5, fundedAmount: 730541 },
    { platform: 'google_ads', monthIndex: 6, budget: 161347, cpa: 580, approvals: 278, costPerFundedDeal: 2997, fundedDeals: 53.8, fundedAmount: 1076587 },
    { platform: 'google_ads', monthIndex: 7, budget: 225886, cpa: 551, approvals: 409.7, costPerFundedDeal: 2848, fundedDeals: 79.3, fundedAmount: 1586549 },
    { platform: 'google_ads', monthIndex: 8, budget: 316241, cpa: 524, approvals: 603.8, costPerFundedDeal: 2705, fundedDeals: 116.9, fundedAmount: 2338073 },
  ],

  /**
   * Placeholder rows so connection health has something to say from day one.
   * `waiting_on_client` is a designed state, not a failure (§9.5).
   */
  connections: [
    {
      platform: 'salesforce',
      accountIdentifier: 'pending',
      // The JWT connection itself works. What is outstanding is org
      // configuration, which is the client's to make — so this is a dependency,
      // not a failure (§9.5).
      // Resolved 17 September 2026: the Opportunity click-ID fields exist and
      // the conversion mapping carries all six. What remains is field-level and
      // surfaced as blocked dependencies rather than as a broken connection.
      /*
       * Corrected 18 September 2026. This was `degraded` because
       * Opportunity.csbs__Decline_Reason__c does not exist — but the reason is
       * now read at lender grain from csbs__Submission__c, where it lives, and
       * the absent field is no longer in the mapping. The sync reports
       * `succeeded`.
       *
       * What remains outstanding is one unused field, which is a dependency on
       * a decision rather than on a fix, so it is stated without degrading the
       * connection. A connection that is permanently amber teaches everybody
       * to ignore the colour.
       */
      status: 'healthy',
      // No blockedReason: the field is optional and absent means nothing is
      // outstanding, which is stronger than an empty string.
      config: {
        audience: 'https://login.salesforce.com',
        /**
         * Field mapping for this org. Spartan's stage timestamps come from a
         * managed package (csbs__); another client's will not, which is why this
         * is a configuration row and not a constant.
         */
        fieldMapping: {
          lead: {
            // Confirmed present. The Opportunity side does not exist yet.
            //
            // The casing is load-bearing. `normalizeLead` reads `record[field]`
            // off the REST response, which is a case-sensitive property lookup,
            // and Salesforce returns each field under its canonical API name.
            // In this org that name is lowercase `gclid__c`. `GCLID__c` parses,
            // validates (validateMapping compares case-insensitively) and reads
            // `undefined` on every record — attributing nothing, silently.
            /*
             * `acq_fbclid__c` joined this on 19 September 2026, when the Meta
             * connector landed.
             *
             * It was deliberately absent before then, and the reason was not
             * that the field was missing — it exists on Lead and Opportunity,
             * carries 972 leads, and the Lead → Opportunity conversion mapping
             * has always included it. It was absent because reading it would
             * have produced a Meta channel row holding deals against no spend,
             * which is exactly the shape the separation rule forbids. Ingesting
             * Meta spend is what removed the objection, so the two changes
             * belong in the same commit and neither is correct alone.
             *
             * `Gbraid__c`, `Wbraid__c` and `TTCLID__c` stay out. The first two
             * are empty in this org and could never resolve to a campaign; the
             * third has no Opportunity counterpart to convert into.
             */
            clickIds: { google_ads: 'gclid__c', meta: 'acq_fbclid__c' },
            // The MQL bar's two inputs. Confirmed against the org by the probe
            // on 17 September 2026 — these are the real API names, and the
            // only fields in the org that carry either concept at any rate.
            //
            // Both are close to empty on inbound leads (revenue 8.5%, time in
            // business 0.4%), so MQL is currently computable for almost none of
            // them. They are named anyway: the stage has to be derived from the
            // right fields the moment they start being captured, and naming
            // them is what lets `qualifyLead` return `null` — undetermined —
            // rather than the platform guessing. See docs/brief-amendments.md §8.
            selfReportedRevenue: 'csbs__Estimated_Monthly_Revenue__c',
            selfReportedAnnualRevenue: 'AnnualRevenue',
            selfReportedTimeInBusinessMonths: 'Time_in_Business_Months__c',
            // Ordered by how often each is populated on inbound leads, measured
            // 18 September 2026 over 7,291 of them. The first resolvable
            // reading wins, so a straddling band in one field does not shadow a
            // clean answer in the next.
            revenueBands: [
              { field: 'Average_Monthly_Revenue_Text2__c', period: 'monthly' }, // 49.8%
              { field: 'Average_Monthly_Revenue__c', period: 'monthly' },       // 23.3%
              { field: 'Monthly_Revenue_Text__c', period: 'monthly' },          // 23.3%
              { field: 'csbs__Estimated_Monthly_Revenue__c', period: 'monthly' }, // 9.5%
              { field: 'csbs__Monthly_Revenue__c', period: 'monthly' },         // 9.5%
              { field: 'AnnualRevenue', period: 'annual' },                     // 6.6%
              { field: 'Monthly_Revenue__c', period: 'monthly' },               // 4.7%
              { field: 'Annual_Revenue_Text__c', period: 'annual' },            // 4.6%
            ],
            /*
             * Each candidate declares what a bare number in it means. The org
             * was enumerated on 22 September 2026 — 760 queryable objects, every
             * field whose name or label mentions revenue or time in business —
             * and the units below are what the values actually are, not what the
             * field names suggest. See `docs/salesforce-fields.md`.
             */
            timeInBusinessBands: [
              /*
               * The web form's own question, and the best-covered answer in the
               * org by a distance: 1,426 of September's 1,703 inbound leads,
               * 88% of its values resolving.
               *
               * It was missed by the first enumeration, which matched fields
               * whose *name* describes the concept — `time in business`,
               * `years in business`. This one is named after the question a
               * merchant was asked, so no concept-shaped pattern finds it. The
               * lesson is in `docs/salesforce-fields.md`: a field has to be
               * found by what its values look like, not by what it is called.
               */
              { field: 'How_long_have_you_been_in_business__c', unit: 'labelled' },
              { field: 'Years_in_Business__c', unit: 'labelled' },
              { field: 'Time_in_Business__c', unit: 'labelled' },
              // Holds bare `3`, `4`, `5` meaning **years** beside `< 12 Months`
              // meaning months. Read as months — which is what happened until
              // the unit was declared — a three-year-old business failed the
              // twelve-month bar.
              { field: 'Years_In_Business_Text__c', unit: 'years' },
              { field: 'Time_in_Business_SEM_Value__c', unit: 'labelled' },
              { field: 'Time_in_Business_Months__c', unit: 'months' },
            ],
            undecodableFields: [
              {
                field: 'MIRV_Volume_Code__c',
                why:
                  'A vendor code, not an amount: 0000, 1000, 1100 and 1110 on ' +
                  '3,990 leads. It was never mapped, and adding it would have ' +
                  'read 1,527 leads as earning $1,000–$1,111 a month and failing ' +
                  'the revenue bar. Found on 22 September 2026 while enumerating ' +
                  'the org; it is the revenue twin of the retired MIYB field and ' +
                  'carries the identical value set.',
              },
            ],
            // Rates below are within the inbound population (n = 7,196), which
            // is the only population this platform counts. See `lead_exclusion`.
            utmSource: 'utm_source__c', // 58.4%
            utmMedium: 'utm_medium__c', // 49.1%
            utmCampaign: 'utm_campaign__c', // 59.2%
            utmContent: 'utm_content__c', // 46.4%
            utmTerm: 'utm_term__c', // 46.1%
            // Not `Landing_Page_Variant__c`, whose values are A/B labels like
            // "lp1" rather than pages, and not `Web_Capture_URL__c` at 4.0%.
            // `pi__url__c` is Account Engagement's own capture and the
            // best-covered field in the inventory.
            landingPage: 'pi__url__c', // 79.6%
            /*
             * The join to the dialer, in priority order.
             *
             * A call record knows the number it dialled and nothing else about
             * a lead, so without these there is no call tracking at all —
             * every call would be unmatched and speed to lead unmeasurable.
             * `Phone` first because Spartan's web forms write it; `MobilePhone`
             * catches the leads where they did not.
             */
            phones: ['Phone', 'MobilePhone'],
            industry: 'Industry', // 34.5%
            state: 'State', // 29.3%
          },
          opportunity: {
            /**
             * Live since 17 September 2026: the fields exist on Opportunity and
             * the Lead → Opportunity conversion mapping carries all six.
             *
             * This route covers an opportunity created directly, which the
             * converted-Lead backfill cannot reach. It does not backfill:
             * Salesforce lead field mapping copies at the moment of conversion
             * and never retrospectively, so every opportunity converted before
             * the mapping existed still holds null here and is covered by
             * `backfillClickIdsFromConvertedLeads` instead.
             *
             * Casing is load-bearing — `normalizeOpportunity` reads
             * `record[field]` off the REST response, which is a case-sensitive
             * property lookup against the canonical API name.
             *
             * `Gbraid__c` and `Wbraid__c` are mapped in Salesforce and captured
             * there, but are absent here on purpose: one platform key holds one
             * field, and Google's `click_view` only ever returns `gclid`. A
             * gbraid touch could never resolve to a campaign, so promoting it to
             * the join key would turn a deal we can cost into one we cannot.
             */
            clickIds: {
              google_ads: 'gclid__c',
              microsoft_ads: 'msclkid__c',
              meta: 'acq_fbclid__c',
              linkedin_ads: 'Li_Fat_ID__c',
            },
            amount: 'Amount',
            /*
             * What the deal actually funded for, which is not `Amount`.
             *
             * A formula over the selected lender offer
             * (`csbs__Selected_Offer__r.csbs__Funded__c`). `Amount` is what was
             * asked for and can be far off: Shreeji Sales asked for $64,200
             * and funded $40,900, which overstated September's volume by
             * $23,300. It is also populated on five deals that were declined
             * or lost after an offer was selected, which is harmless — volume
             * sums only deals that reached Funded.
             */
            fundedAmount: 'csbs__Funded__c',
            /*
             * The deal type, read by `stage_exclusions`. Blank on 562 of 734
             * opportunities (23 September 2026), so a renewal nobody labelled
             * is counted as a new deal — the rule is only as good as the field.
             */
            dealType: 'Type',
            /*
             * Deliberately no decline reason here any more.
             *
             * It pointed at csbs__Decline_Reason__c, which does not exist in
             * the org. That was kept on purpose while the reason was
             * unmeasured, so validateMapping would keep reporting it — but the
             * reason is now read at lender grain from Decline_Reason__c on
             * csbs__Submission__c, where it actually lives. Keeping a
             * permanently absent field would leave the connection `Degraded`
             * and every sync `partial` for a gap that is closed, which is the
             * fastest way to make a real warning invisible. The deal-grain gap
             * stays recorded as a blocked dependency.
             */
          },
          stages: {
            sql: 'csbs__Underwriting_Date_Time__c',
            // `uw_approved` is deliberately absent here.
            // `csbs__Approved_Date_Time__c` exists and is empty on every
            // opportunity in the org, so mapping it produced a stage with no
            // source. The transitions are in `OpportunityFieldHistory` instead
            // and are read by `extractStageHistoryEvents`; leaving the field
            // mapped as well would add a column of nulls to every query for
            // nothing.
            offer: 'Offer_Received_Date_Time__c',
            funded: 'csbs__Funded_Date_Time__c',
          },
          extraStageEvents: {
            declined: 'csbs__Declined_Date_Time__c',
            contract_requested: 'Contract_Requested_Date_Time__c',
          },
          derivedStages: {
            // Renamed from `lead` on 17 September 2026. This rule stamps the
            // moment an Opportunity record exists, which is an application —
            // the Lead stage above it counts the `leads` table instead.
            application: 'opportunity_created',
            // No MQL timestamp exists in the org. Derived from the
            // qualification minimums and marked computed wherever it renders.
            mql: 'qualification_minimums',
          },
          /**
           * Lender grain. Added 18 September 2026.
           *
           * The status vocabulary is this org's, which is why the four lists
           * below are configuration and not a switch statement. Only
           * `Offer(s) Received` and `Declined` are lender decisions; the rest
           * are the pipeline, and 706 of 1,427 submissions sit in it at any
           * moment. Putting those in a denominator would report a lender as
           * declining a deal it has not answered on.
           *
           * `Closing`, `Closing Incomplete` and `Contract Ready` are listed as
           * open rather than as offers even though each of them implies an
           * offer exists, because the status is the *current* one and these
           * three describe what is happening now rather than the lender's
           * answer. They are two records between them, so nothing material
           * turns on it — and the raw status is stored, so revisiting the
           * judgement is a query rather than a re-ingest.
           */
          submissions: {
            object: 'csbs__Submission__c',
            opportunity: 'csbs__Opportunity__c',
            lender: 'csbs__Lender__c',
            // A relationship path: the lender is an Account, and the platform
            // does not ingest Accounts to label six of them.
            lenderName: 'csbs__Lender__r.Name',
            status: 'csbs__Status__c',
            // Spartan's own field, not the managed package's — which is why a
            // search for csbs__Decline_Reason__c found nothing and this was
            // reported as absent for a day.
            declineReason: 'Decline_Reason__c',
            offeredStatuses: ['Offer(s) Received'],
            declinedStatuses: ['Declined'],
            failedStatuses: ['Failed', 'Incomplete Application', 'Partial Submission'],
            openStatuses: [
              'Submitted',
              'Pending',
              'Closing',
              'Closing Incomplete',
              'Contract Ready',
            ],
          },
        },
      },
    },
    {
      platform: 'google_ads',
      /**
       * The normalised form, with no dashes.
       *
       * This is the seed's upsert key, and `test-connection` rewrites the stored
       * identifier to whatever the API reports — which is the dashless form.
       * A dashed value here therefore stops matching the row it created and the
       * next seed inserts a second connection for the same account, which the
       * nightly fan-out then syncs twice. The two must agree, and the API's
       * spelling is the one that wins.
       */
      accountIdentifier: '4677473505',
      // Connected 17 September 2026. Credentials live encrypted in the
      // connection row; the seed never rewrites them.
      status: 'healthy',
      config: {
        // The client's own manager account, not a Zeeraa MCC. Another tenant may
        // arrive under a different arrangement entirely; nothing in the connector
        // assumes one agency-level account covers every client.
        loginCustomerId: '6962685494',
        // Spartan Business Solutions LLC, the account in scope for the
        // engagement. One connection reports on one account; a second account
        // under the same manager would be a second connection row.
        customerId: '4677473505',
      },
    },
    { platform: 'microsoft_ads', accountIdentifier: 'pending', status: 'not_configured' },
    {
      /*
       * Live since 19 September 2026. Campaign grain, read synchronously.
       *
       * Deliberately seeded as `not_configured` rather than `healthy`: the
       * account identifier and the reading configuration are known, and the
       * system user token is not — it is stored encrypted per tenant by
       * `set-credentials`, and the first `test-connection` after that is what
       * moves this to healthy. A seed that claimed health before a credential
       * existed would put a green light on a connection that cannot pull.
       */
      platform: 'meta',
      accountIdentifier: '648661540906332',
      status: 'not_configured',
      config: {
        adAccountId: '648661540906332',
        /*
         * `lead` alone, and the singular matters. Meta's `actions` array
         * contains rollups beside their own components: over the trailing 90
         * days `lead` is 1,756, which is exactly `onsite_web_lead` (921) plus
         * `onsite_conversion.lead_grouped` (835). Nothing in the payload marks
         * which nest, so listing the components alongside the rollup would
         * report double the conversions and look entirely plausible.
         */
        conversionActionTypes: ['lead'],
        /*
         * Link clicks, not all clicks. Meta's `clicks` counts reactions,
         * comments and profile taps; Google Ads' `clicks` counts clicks that go
         * somewhere. Over the same window the two are 8,074 and 5,135, and the
         * performance table puts them in one column under one heading.
         */
        clickMetric: 'inline_link_clicks',
      },
    },
    { platform: 'linkedin_ads', accountIdentifier: 'pending', status: 'not_configured' },
    {
      /*
       * GA4 and Search Console read the *Google Ads* credential — one OAuth
       * client, one refresh token, one person's consent, three APIs. So neither
       * row holds credentials of its own, and both stop working the moment that
       * token is re-issued without their scopes.
       *
       * Seeded `not_configured`: the property is known and the credential's
       * reach is not, and only `test-connection` proves the latter.
       */
      platform: 'ga4',
      accountIdentifier: '464257863',
      status: 'not_configured',
      config: {
        propertyId: '464257863',
        // Rows of each breakdown kept per day. The daily total row is
        // authoritative; the breakdown is the top N of that day and the page
        // states what share of the total it accounts for.
        breakdownLimit: 250,
      },
    },
    {
      platform: 'search_console',
      // Exactly as Search Console spells it, trailing slash included. A
      // URL-prefix property and a `sc-domain:` property are different
      // properties with different data, and a near-miss answers 403.
      accountIdentifier: 'https://www.spartancapitalgroup.com/',
      status: 'not_configured',
      config: {
        siteUrl: 'https://www.spartancapitalgroup.com/',
        breakdownLimit: 250,
      },
    },
    { platform: 'semrush', accountIdentifier: 'pending', status: 'not_configured' },
    {
      /*
       * Corrected 18 September 2026. This said the vendor had not been
       * selected, which was wrong for months: Aloware is live and has been
       * writing 12,000–15,000 calls a month since June. The blocked state was
       * describing the engagement rather than the org.
       *
       * `healthy` with no blockedReason. The history is imported from an
       * export and everything after it arrives on the webhook, so there is no
       * outstanding dependency on the client — only on us, to keep the
       * subscription pointed at the endpoint.
       */
      platform: 'call_tracking',
      accountIdentifier: 'aloware',
      status: 'healthy',
    },
  ],

  /**
   * Cut from the funnel and the breakdowns, and recorded here rather than
   * deleted, so each absence renders as a named dependency with its reason
   * instead of as a zero. Every figure is within the inbound population
   * (n = 7,196), measured 17 September 2026.
   */
  blockedDependencies: [
    {
      /*
       * Unblocked 18 September 2026, at lender grain.
       *
       * The reason survived on the wrong object. `Loss_Reason__c` on
       * Opportunity is abandoned and nothing brings it back — but a decline is
       * a lender's decision, and `Decline_Reason__c` on csbs__Submission__c
       * holds it: 16 values, 121 of 590 declined submissions, rising from 0%
       * of June's declines to 30.5% of September's.
       *
       * This row is kept, re-scoped to the deal-level field, because the
       * deal-level composition still cannot be stated — it is the thing a
       * reader will assume the lender chart shows. Coverage is rendered per
       * month and never summed: an all-time figure would average an unused
       * field with an adopted one.
       */
      key: 'decline_reason_deal_grain',
      subjectKind: 'breakdown',
      subjectKey: 'decline_reason_deal',
      label: 'Decline reasons, per deal',
      reason:
        'Lender decline reasons are measured, at lender grain, from ' +
        'Decline_Reason__c on csbs__Submission__c. What is not measured is a ' +
        'reason per *deal*: Loss_Reason__c was filled in on every closed-lost ' +
        'opportunity through January 2025 — 68 of 68 that month, 23 of 23 in ' +
        'December 2024 — and then abandoned, 0 of 133 in July 2026, 2 of 132 in ' +
        'August, 1 of 66 in September. No other field on Opportunity carries ' +
        'one: Competitor_Lost_To__c and Do_Not_Call_Reason__c are empty on all ' +
        '716. A deal declined by three lenders for three different reasons has ' +
        'no single reason in the CRM, and the platform does not choose one.',
      needed:
        'The reason field filled in on closed-lost opportunities again. The ' +
        'picklist already exists and already has sensible values.',
      evidence:
        '110 of 543 closed-lost opportunities carry a reason, and every one of ' +
        'them closed before February 2026. Closed-lost since: 0 of 133 in July ' +
        '2026, 2 of 132 in August, 1 of 66 in September. The ' +
        'mapping also points at csbs__Decline_Reason__c, which does not exist in ' +
        'the org \u2014 left in place deliberately so validateMapping keeps failing ' +
        'visibly rather than writing nulls into a column that looks like data.',
    },
    {
      // Not a blocked stage: MQL is computed and renders with its coverage.
      // What is blocked is the coverage itself, and this is the single biggest
      // reason it falls short — so it is a dependency on the client, stated as
      // one, rather than a caveat buried beside a number.
      key: 'mql_revenue_coverage',
      subjectKind: 'metric',
      subjectKey: 'mql_coverage',
      label: 'MQL coverage — revenue',
      reason:
        'What is left is mostly an unanswered question rather than an ' +
        'unreadable answer. 79.8% of inbound leads can now be judged against ' +
        'the bar. Of the 1,512 that cannot, about 1,240 never answered one or ' +
        'both questions at all, 257 answer revenue as "< $15,000", which ' +
        'genuinely contains the $10,000 bar, and 15 carry a duration answer ' +
        'nothing can read.',
      needed:
        'Making both questions required on the web forms, which is what moves ' +
        'the 1,240. Splitting the "< $15,000" option would settle the 257; the ' +
        'band contains the bar and choosing a side would be inventing the ' +
        'answer.',
      evidence:
        'Measured 22 September 2026 with `pnpm --filter @zeeraa/connectors ' +
        'qualification-coverage`: duration 83.3% populated and 83.1% usable, ' +
        'revenue 85.6% populated and 82.2% usable, both 79.2%. After the ' +
        're-pull, leads.mql_verdict reads 30.9% qualified, 48.9% unqualified ' +
        'and 19.8% undeterminable, against 15.8% / 38.5% / 42.1% before.',
    },
    {
      // Not a blocked stage. Both ends are measured: the approval transitions
      // are in field history and the offer timestamps are in a field. The
      // metric over them is what does not mean what its name says, so it is
      // suppressed on its own.
      key: 'offer_rate_definition',
      subjectKind: 'metric',
      subjectKey: 'offer_rate',
      label: 'Offer rate',
      reason:
        'Offer rate as defined measures manual completion of ' +
        'Offer_Received_Date_Time__c rather than a conversion. Approval and the ' +
        'first lender offer are the same event — the median gap between the ' +
        'transition into Approved and the first Offer record is 0.0 hours, and ' +
        'in 98 of 112 cases the offer record exists before the stage changes — ' +
        'so there is no step between them a deal can fail. The rate also ' +
        'divided populations that do not nest: 10 of the 67 offers in the ' +
        'window belong to deals with no approval event at all.',
      needed:
        'A submission-level offer rate, from csbs__Submission__c: offers ' +
        'received over decided submissions, per lender. Measured at 18.2% ' +
        'across 131 offered and 590 declined submissions, which is the figure ' +
        'the deal-level rate was standing in for.',
      evidence:
        'Measured 18 September 2026. 112 of 115 approved deals hold a ' +
        'csbs__Offer__c record but only 57 hold the date field, so the field ' +
        'is absent about half the time. Of the 125 deals holding an offer ' +
        'record, 88 are currently lost and 21 funded — offer is not a stage a ' +
        'deal stays in.',
    },
    {
      key: 'revenue_band_breakdown',
      subjectKind: 'breakdown',
      subjectKey: 'revenue_band',
      label: 'Revenue bands',
      reason:
        'Partially measurable. The revenue answer is readable as a band on 87–97% ' +
        'of inbound leads each month from June to September 2026, but the forms ' +
        'offer bands that overlap — $10,000–$20,000 beside $15,000–$35,000 and ' +
        '$10k–$15k — so there is no single set of bands to break leads down by, ' +
        'and only the MQL verdict is stored at ingest, not the band.',
      needed:
        'One set of revenue bands shared by every web form. On Zeeraa’s side, the ' +
        'band stored per lead at ingest, which is platform work rather than a ' +
        'client dependency.',
      evidence:
        'Measured 23 September 2026 from Salesforce, inbound leads, eight revenue ' +
        'fields read in the MQL order: populated 88.1–98.9% per month Jun–Sep, ' +
        'readable as a band 87.0–96.9%. Most common answers: "Less than $10,000" ' +
        '(1,367), "$10,000 - $20,000" (834), "< $10,000" (618), "less than ' +
        '$10,000" (614), "$20,000 - $50,000" (330). The 8.8% figure this row ' +
        'quoted before counted numeric fields only.',
    },
  ],

  reconciliation: [
    {
      key: 'cpa_definition',
      label: 'What "CPA" refers to',
      question:
        'Does CPA mean cost per approval, cost per qualified lead, or the platform’s own ' +
        'cost per conversion? Three sources use the same word for three denominators, and ' +
        'the budget model is the only one that defines it arithmetically.',
      claims: [
        { value: '$2,000 today, $1,000 target', source: 'Proposal, targets section' },
        { value: '$108.59 cost per conversion', source: 'Google Ads baseline, Jun–Aug 2026' },
        {
          // Added 22 September 2026, on reading the model file. This claim is
          // different in kind from the two above: it is not an assertion about
          // a figure, it is a definition the model computes from its own
          // columns and reproduces in all eight months. $30,000 ÷ 40 approvals
          // = $750; $316,241 ÷ 603.8 = $524. So the *ramp's* CPA is settled
          // even while the KPI's is not, and the two must not be conflated.
          value: '$750 in M1 falling to $524 in M8 — budget ÷ approvals',
          source: 'SpartanCapital Google Ads Budget Projection for 8 Months',
        },
      ],
      resolution: {
        value: 'Cost per approval: attributed spend ÷ UW approvals, $750 in M1 to $524 in M8',
        note:
          'The M1–M8 engagement model governs all targets — it is Zeeraa’s committed ' +
          'target sheet (client decision, 23 September 2026). Its CPA is budget ÷ ' +
          'approvals in every month, so the KPI divides by UW approved.',
        resolvedOn: '2026-09-23',
      },
    },
    {
      key: 'funded_targets',
      label: 'Funded economics targets',
      question:
        'Cost per funded deal of $4,500 within 30 days implies roughly 22 funded deals to ' +
        'reach a $100K month at the stated average. Which of the three figures is committed?',
      claims: [
        { value: '$8,000 → $4,500 cost per funded deal within 30 days', source: 'Proposal' },
        { value: 'Milestone ladder starts at $30K funded volume', source: 'Proposal, milestones' },
        { value: 'Month-one funded volume of $100–150K', source: 'Proposal, month-one plan' },
      ],
      resolution: {
        value:
          'The engagement model: cost per funded deal $4,000 in M1 to $2,705 in M8, ' +
          'funded volume $80,000 in M1 to $2,338,073 in M8',
        note:
          'The M1–M8 engagement model governs all targets — it is Zeeraa’s committed ' +
          'target sheet (client decision, 23 September 2026). The proposal’s figures ' +
          'are superseded.',
        resolvedOn: '2026-09-23',
      },
    },
    {
      key: 'owned_database_size',
      label: 'Size of the owned database',
      question: 'Is the owned database 1,000,000 records or 100,000?',
      claims: [
        { value: '1,000,000 records', source: 'Proposal, audience section' },
        { value: '100,000 records', source: 'Proposal, email section' },
      ],
    },
    {
      key: 'backlink_commitment',
      label: 'Backlink commitment',
      question: 'Is the commitment 30–40 per month, or 30–50 in the first 30 days?',
      claims: [
        { value: '30–40 quality backlinks per month', source: 'Proposal, deliverables' },
        { value: '30–50 backlinks in the first 30 days', source: 'Proposal, month-one plan' },
      ],
    },
  ],
};
