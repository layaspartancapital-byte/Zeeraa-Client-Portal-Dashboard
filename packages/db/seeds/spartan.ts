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
    { position: 1, key: 'lead', label: 'Lead' },
    { position: 2, key: 'mql', label: 'MQL' },
    { position: 3, key: 'sql', label: 'SQL' },
    { position: 4, key: 'uw_approved', label: 'UW approved', isOptimizationTarget: true },
    { position: 5, key: 'offer', label: 'Offer', isOptimizationTarget: true },
    { position: 6, key: 'funded', label: 'Funded', isOptimizationTarget: true, countsValue: true },
  ],

  metrics: [
    {
      key: 'cost_per_funded_deal',
      label: 'Cost per funded deal',
      formulaKey: 'cost_per_funded_deal',
      improvementDirection: 'down',
      isNorthStar: true,
      targetValue: '4500',
      needsReconciliation: true,
      reconciliationNote:
        'Target of $4,500 within 30 days sits beside a milestone ladder starting at ' +
        '$30K funded volume and a month-one funded volume target of $100–150K. ' +
        'Those three cannot all hold at once.',
      definition:
        'Attributed media spend and fees in the period divided by the number of ' +
        'deals that reached the Funded stage in the same period.',
    },
    {
      key: 'funded_volume',
      label: 'Funded volume',
      formulaKey: 'funded_volume',
      improvementDirection: 'up',
      targetValue: '100000',
      needsReconciliation: true,
      reconciliationNote:
        'Month-one target stated as $100–150K; the milestone ladder starts at $30K.',
      definition: 'Sum of the funded amount on every deal that reached Funded in the period.',
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
      key: 'cpa',
      label: 'Cost per acquisition',
      formulaKey: 'cost_per_stage',
      formulaArgs: { stage: 'sql' },
      improvementDirection: 'down',
      targetValue: '1000',
      needsReconciliation: true,
      reconciliationNote:
        'CPA is quoted as $2,000 today improving to $1,000, while the Google Ads ' +
        'baseline reports cost per conversion of $108.59. These are two different ' +
        'definitions of the same word and must be settled before either renders.',
      definition: 'Attributed spend divided by the count reaching the configured stage.',
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
    {
      key: 'sla_compliance',
      label: 'SLA compliance',
      formulaKey: 'sla_compliance',
      improvementDirection: 'up',
      targetValue: '1',
      definition: 'SLA events meeting their commitment divided by all SLA events in the period.',
    },
    {
      key: 'delivery_completion',
      label: 'Delivery completion',
      formulaKey: 'delivery_completion',
      improvementDirection: 'up',
      targetValue: '1',
      definition: 'Delivered quantity divided by committed quantity, per commitment, per period.',
    },
  ],

  config: [
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

  commitments: [
    { key: 'ad_creatives', label: 'Ad creatives', quantity: 20, unit: 'creatives', period: 'monthly', requiresClientApproval: true },
    { key: 'landing_pages', label: 'Landing pages', quantity: 2, unit: 'pages', period: 'monthly', requiresClientApproval: true },
    { key: 'articles', label: 'Articles, guides & case studies', quantity: 8, unit: 'pieces', period: 'monthly', requiresClientApproval: true },
    { key: 'backlinks', label: 'Quality backlinks', quantity: 30, quantityMax: 40, unit: 'links', period: 'monthly' },
    { key: 'ab_tests', label: 'Concurrent A/B tests', quantity: 2, quantityMax: 3, unit: 'tests', period: 'monthly' },
    { key: 'geo_prompts', label: 'GEO / AI prompts tracked', quantity: 50, unit: 'prompts', period: 'monthly' },
    { key: 'ceo_pitch', label: 'CEO thought-leadership pitch', quantity: 1, unit: 'pitches', period: 'monthly', requiresClientApproval: true },
    { key: 'email_flow', label: 'Email flow', quantity: 1, unit: 'flows', period: 'monthly', requiresClientApproval: true },
    { key: 'newsletter', label: 'Newsletter', quantity: 1, unit: 'sends', period: 'monthly', requiresClientApproval: true },
    { key: 'webinar', label: 'Produced webinar', quantity: 1, unit: 'webinars', period: 'quarterly' },
    { key: 'qbr', label: 'Quarterly business review', quantity: 1, unit: 'reviews', period: 'quarterly' },
  ],

  slaCommitments: [
    { type: 'slack_response', label: 'Slack response in working hours', targetMinutes: 60, cadence: '9am–3pm ET, Mon–Fri' },
    { type: 'daily_update', label: 'Daily progress update', cadence: 'Each working day' },
    { type: 'weekly_call', label: 'Weekly strategy call', cadence: 'Weekly' },
    { type: 'monthly_report', label: 'Monthly report', cadence: 'Monthly' },
    { type: 'qbr', label: 'Quarterly business review', cadence: 'Quarterly' },
  ],

  assetTypes: [
    { key: 'article', label: 'Article / blog' },
    { key: 'pr_placement', label: 'PR placement' },
    { key: 'ad_creative', label: 'Ad creative' },
    { key: 'landing_page', label: 'Landing page design or spec' },
    { key: 'video_script', label: 'Video script' },
    { key: 'email_flow', label: 'Email flow' },
    { key: 'report', label: 'Report or deck' },
    { key: 'webinar', label: 'Webinar material' },
    { key: 'other', label: 'Other' },
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
      status: 'waiting_on_client',
      blockedReason:
        'Click IDs do not survive Lead → Opportunity conversion. The Opportunity ' +
        'fields and the lead field mappings are being created. Leads, ' +
        'opportunities and stage events sync without them; attribution does not. ' +
        'See docs/salesforce-fields.md.',
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
            clickIds: { google_ads: 'gclid__c' },
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
            industry: 'Industry', // 34.5%
            state: 'State', // 29.3%
          },
          opportunity: {
            clickIds: {},
            amount: 'Amount',
            declineReason: 'csbs__Decline_Reason__c',
          },
          stages: {
            sql: 'csbs__Underwriting_Date_Time__c',
            uw_approved: 'csbs__Approved_Date_Time__c',
            offer: 'Offer_Received_Date_Time__c',
            funded: 'csbs__Funded_Date_Time__c',
          },
          extraStageEvents: {
            declined: 'csbs__Declined_Date_Time__c',
            contract_requested: 'Contract_Requested_Date_Time__c',
          },
          derivedStages: {
            lead: 'opportunity_created',
            // No MQL timestamp exists in the org. Derived from the
            // qualification minimums and marked computed wherever it renders.
            mql: 'qualification_minimums',
          },
        },
      },
    },
    {
      platform: 'google_ads',
      accountIdentifier: '467-747-3505',
      status: 'waiting_on_client',
      blockedReason:
        'Awaiting the OAuth refresh token. Every Google Ads credential for this tenant ' +
        'belongs to Spartan rather than to Zeeraa: the manager account is theirs, ' +
        'the OAuth consent is theirs, and since Google sunset developer tokens on ' +
        '9 September 2026 the API access level belongs to the Google Cloud project ' +
        'behind their OAuth client. Needed: a Desktop-app client id and secret, and ' +
        'a refresh token from `pnpm --filter @zeeraa/connectors google-ads-token`. ' +
        'A developer token is not required.',
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
    { platform: 'meta', accountIdentifier: 'pending', status: 'not_configured' },
    { platform: 'linkedin_ads', accountIdentifier: 'pending', status: 'not_configured' },
    { platform: 'ga4', accountIdentifier: 'pending', status: 'not_configured' },
    { platform: 'search_console', accountIdentifier: 'pending', status: 'not_configured' },
    { platform: 'semrush', accountIdentifier: 'pending', status: 'not_configured' },
    {
      platform: 'call_tracking',
      accountIdentifier: 'pending',
      status: 'waiting_on_client',
      blockedReason: 'Call tracking vendor not yet selected. No connector can be configured until it is.',
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
      key: 'mql_stage',
      subjectKind: 'funnel_stage',
      subjectKey: 'mql',
      label: 'MQL',
      reason:
        'MQL is derived from monthly revenue and time in business, and both are ' +
        'close to empty on inbound leads. Time in business is recorded on 0.4% ' +
        'of them. A count here would be the handful of leads that happen to ' +
        'carry both attributes, not the number of qualified leads.',
      needed:
        'A monthly-revenue and a time-in-business question on the web forms, ' +
        'posting into csbs__Estimated_Monthly_Revenue__c and ' +
        'Time_in_Business_Months__c. Both fields already exist in Salesforce; ' +
        'nothing needs creating.',
      evidence:
        'Inbound leads, 17 September 2026: time in business 0.4% (32 of 7,196), ' +
        'monthly revenue 8.8% (635), annual revenue 6.7% (482). Of the 652 leads ' +
        'that converted, two carry a time in business. The populated values are ' +
        'also selected rather than sampled \u2014 every one is 12 months or more, ' +
        'minimum exactly 12 \u2014 so a rate computed over them would measure a list ' +
        'vendor\u2019s filter rather than lead quality.',
    },
    {
      key: 'uw_approved_stage',
      subjectKind: 'funnel_stage',
      subjectKey: 'uw_approved',
      label: 'UW approved',
      reason:
        'The approval timestamp is never written. csbs__Approved_Date_Time__c ' +
        'exists on Opportunity and is empty on all 712 of them, so there is no ' +
        'source for this stage \u2014 the conversion rate into and out of it would ' +
        'read zero for every period.',
      needed:
        'Either the stage starts being stamped in Salesforce, or UW approved ' +
        'comes out of funnel_stages and SQL \u2192 Offer becomes the measured ' +
        'transition. A configuration decision either way.',
      evidence:
        'csbs__Approved_Date_Time__c: 0 of 712 opportunities. For contrast, ' +
        'csbs__Declined_Date_Time__c is populated on 487 and 25 opportunities ' +
        'are won, so approvals are happening and are simply not stamped.',
    },
    {
      key: 'decline_reason_breakdown',
      subjectKind: 'breakdown',
      subjectKey: 'decline_reason',
      label: 'Decline reasons',
      reason:
        'Loss_Reason__c stopped being filled in. Every recorded reason predates ' +
        'February 2026, and the last 180 days hold none at all. A breakdown ' +
        'would describe the 2024 loss mix and present it as current.',
      needed:
        'The reason field filled in on closed-lost opportunities again. The ' +
        'picklist already exists and already has sensible values.',
      evidence:
        '107 of 525 closed-lost opportunities carry a reason; all 107 closed ' +
        'before February 2026. Closed-lost in the last 180 days: 0 of 414. The ' +
        'mapping also points at csbs__Decline_Reason__c, which does not exist in ' +
        'the org \u2014 left in place deliberately so validateMapping keeps failing ' +
        'visibly rather than writing nulls into a column that looks like data.',
    },
    {
      key: 'revenue_band_breakdown',
      subjectKind: 'breakdown',
      subjectKey: 'revenue_band',
      label: 'Revenue bands',
      reason:
        'Banding leads by revenue needs a revenue figure, and inbound leads ' +
        'mostly do not carry one. Where both figures are present they disagree ' +
        'more often than not, so there is not even a consistent basis to band on.',
      needed:
        'The same web-form revenue question that unblocks MQL. One field is ' +
        'enough; the platform normalises monthly and annual to a monthly basis.',
      evidence:
        'Inbound leads: monthly revenue 8.8% (635 of 7,196), annual revenue ' +
        '6.7% (482). One lead in the org carries both, and the two figures ' +
        'disagree beyond the 10% tolerance.',
    },
  ],

  reconciliation: [
    {
      key: 'cpa_definition',
      label: 'What "CPA" refers to',
      question:
        'Does CPA mean cost per qualified lead, cost per funded deal, or the platform’s ' +
        'own cost per conversion? Three figures in the paperwork use the same word.',
      claims: [
        { value: '$2,000 today, $1,000 target', source: 'Proposal, targets section' },
        { value: '$108.59 cost per conversion', source: 'Google Ads baseline, Jun–Aug 2026' },
      ],
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
