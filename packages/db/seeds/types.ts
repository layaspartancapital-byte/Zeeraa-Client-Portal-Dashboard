export type TenantSeed = {
  tenant: {
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    accentColor: string;
  };
  funnelStages: {
    position: number;
    key: string;
    label: string;
    isOptimizationTarget?: boolean;
    countsValue?: boolean;
    /** Where the stage is counted from. Defaults to opportunity stage events. */
    source?: 'stage_events' | 'leads' | 'qualified_leads';
  }[];
  metrics: {
    key: string;
    label: string;
    formulaKey: string;
    formulaArgs?: Record<string, unknown>;
    improvementDirection: 'up' | 'down';
    isNorthStar?: boolean;
    targetValue?: string;
    needsReconciliation?: boolean;
    reconciliationNote?: string;
    definition?: string;
  }[];
  config: { key: string; description?: string; value: unknown }[];
  /**
   * The engagement ramp, per platform. `monthIndex` is 1-based and lands on
   * whatever month `engagement_start_month` records; a figure nobody has
   * supplied is null, never zero.
   */
  engagementTargets: {
    platform: string;
    monthIndex: number;
    costPerFundedDeal?: number;
    budget?: number;
    cpa?: number;
    approvals?: number;
    fundedDeals?: number;
    fundedAmount?: number;
  }[];
  baselines: {
    key: string;
    label: string;
    platform?: string;
    periodStart: string;
    periodEnd: string;
    note?: string;
    metrics: Record<string, number>;
  }[];
  milestones: { metricKey: string; ladder: number[] };
  connections: {
    platform: string;
    accountIdentifier: string;
    status: 'not_configured' | 'healthy' | 'degraded' | 'failing' | 'waiting_on_client';
    blockedReason?: string;
    config?: Record<string, unknown>;
  }[];
  reconciliation: {
    key: string;
    label: string;
    question: string;
    claims: { value: string; source: string }[];
    /** Set once the client has settled it; `resolvedOn` is `YYYY-MM-DD`. */
    resolution?: { value: string; note: string; resolvedOn: string };
  }[];
  /**
   * Things the UI would otherwise render that have no honest source yet (§9.5).
   * Each one renders as a named blocked state rather than as a zero.
   */
  blockedDependencies: {
    key: string;
    subjectKind: 'funnel_stage' | 'breakdown' | 'metric';
    subjectKey: string;
    label: string;
    reason: string;
    needed?: string;
    evidence?: string;
  }[];
};
