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
  commitments: {
    key: string;
    label: string;
    quantity: number;
    quantityMax?: number;
    unit: string;
    period: 'monthly' | 'quarterly';
    requiresClientApproval?: boolean;
  }[];
  slaCommitments: {
    type: 'slack_response' | 'daily_update' | 'weekly_call' | 'monthly_report' | 'qbr';
    label: string;
    targetMinutes?: number;
    cadence?: string;
  }[];
  assetTypes: { key: string; label: string }[];
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
