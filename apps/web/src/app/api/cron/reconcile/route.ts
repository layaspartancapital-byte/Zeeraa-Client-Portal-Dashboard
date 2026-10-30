import type { NextRequest } from 'next/server';
import { refuseUnlessCron } from '@/lib/cron-auth';
import { autoCorrectLeadFigures, autoFreeze, runReconciliation, tenantsWithRamp } from '@zeeraa/jobs';

/**
 * The daily reconciliation, then the baseline freeze, driven by Vercel Cron.
 *
 * An hour after the nightly re-pull, so it compares against freshly re-read
 * data: each source's own totals for last month and this month to yesterday
 * against ours (`runReconciliation`), written to `reconciliation_checks` for
 * the Connections screen. Then any baseline month due to freeze is frozen —
 * only where that reconciliation came back clean (`autoFreeze`). Then a
 * frozen lead count Salesforce has since moved — every lead that moved merged,
 * deleted or edited there — is frozen as its next version
 * (`autoCorrectLeadFigures`); the deploy's number check lets such a
 * difference through and leaves the write to this run.
 */
async function handle(request: NextRequest): Promise<Response> {
  const refused = refuseUnlessCron(request, 'reconcile');
  if (refused) return refused;

  const reconciled = await runReconciliation();
  const frozen: Record<string, unknown> = {};
  const corrected: Record<string, unknown> = {};
  for (const tenantId of await tenantsWithRamp()) {
    try {
      frozen[tenantId] = await autoFreeze(tenantId);
    } catch (error) {
      frozen[tenantId] = { error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const outcomes = await autoCorrectLeadFigures(tenantId);
      corrected[tenantId] = outcomes;
      for (const o of outcomes.filter((x) => x.status !== 'unchanged')) {
        console.warn(`[cron/reconcile] baseline ${tenantId.slice(0, 8)} ${o.month} ${o.status}: ${o.detail}`);
      }
    } catch (error) {
      corrected[tenantId] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const drift = reconciled.flatMap((r) => r.checks.filter((c) => c.status === 'drift' || c.status === 'error'));
  for (const c of drift) {
    console.warn(`[cron/reconcile] ${c.source} ${c.metric} ${c.window.start}..${c.window.end} ${c.status}: ${c.detail ?? ''}`);
  }
  return Response.json({
    checks: reconciled.reduce((n, r) => n + r.checks.length, 0),
    drift: drift.length,
    frozen,
    corrected,
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Every source is asked for a few totals; well inside this. */
export const maxDuration = 300;
