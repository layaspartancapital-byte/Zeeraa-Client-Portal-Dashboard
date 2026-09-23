import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { autoFreeze, runReconciliation, tenantsWithRamp } from '@zeeraa/jobs';

/**
 * The daily reconciliation, then the baseline freeze, driven by Vercel Cron.
 *
 * An hour after the nightly re-pull, so it compares against freshly re-read
 * data: each source's own totals for last month and this month to yesterday
 * against ours (`runReconciliation`), written to `reconciliation_checks` for
 * the Connections screen. Then any baseline month due to freeze is frozen —
 * only where that reconciliation came back clean (`autoFreeze`).
 */
function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(request.headers.get('authorization') ?? '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: NextRequest): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    console.error('[cron/reconcile] refused: CRON_SECRET is not set on this deployment');
    return Response.json(
      { ok: false, error: 'CRON_SECRET is not configured on this deployment.' },
      { status: 503 },
    );
  }
  if (!authorised(request)) return new Response('Not found', { status: 404 });

  const reconciled = await runReconciliation();
  const frozen: Record<string, unknown> = {};
  for (const tenantId of await tenantsWithRamp()) {
    try {
      frozen[tenantId] = await autoFreeze(tenantId);
    } catch (error) {
      frozen[tenantId] = { error: error instanceof Error ? error.message : String(error) };
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
