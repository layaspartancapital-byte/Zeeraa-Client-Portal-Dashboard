import type { TenantSeed } from './types';

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
      key: 'qualification_minimums',
      description: 'Drives qualified_rate. A lead must meet every minimum listed.',
      value: { monthlyRevenueMin: 10000, timeInBusinessMonthsMin: 12 },
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
            clickIds: { google_ads: 'GCLID__c' },
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
    { platform: 'google_ads', accountIdentifier: 'pending', status: 'not_configured' },
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
