import {
  Database,
  LineChart,
  Briefcase,
  Megaphone,
  PhoneCall,
  Plug,
  Search,
  Share2,
  Users,
} from 'lucide-react';
import { canAdministerTenant, canManageConnections, formatCount, formatRangeLabel } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { TopBar } from '@/components/shell/TopBar';
import { PrintButton, SyncNowButton } from '@/components/shell/actions';
import {
  connectionHealth,
  reconciliationBySource,
  type ConnectionCard,
  type ReconciliationRow,
} from '@/lib/dashboard';
import { requireRole } from '@/lib/tenant';

export const metadata = { title: 'Connections' };

/**
 * Connection health, one card per platform.
 *
 * `waiting_on_client` is a grey badge with the need on the detail line, not an
 * error: it is a dependency, not a fault, and colouring it red would make a
 * conversation look like a failure. Failures state what broke and what to do,
 * in the interface's voice, without apologising.
 */
const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  // Neutral, not green: green means a metric improved, never a status.
  healthy: { label: 'Healthy', tone: 'neutral' },
  degraded: { label: 'Degraded', tone: 'warn' },
  failing: { label: 'Failing', tone: 'down' },
  waiting_on_client: { label: 'Waiting on client', tone: 'neutral' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
};

/** Which platforms have a connector that "Sync now" can actually drive. */
const SYNCABLE = new Set(['google_ads', 'meta', 'salesforce']);

/**
 * A line icon per platform, from one family.
 *
 * Not vendor logos: the product does not ship other companies' marks, and a
 * row of brand colours would be the loudest thing on a screen whose job is to
 * say which connections are reporting. A platform with no icon of its own gets
 * the generic connector mark rather than a wrong one.
 */
const ICONS: Record<string, typeof Plug> = {
  salesforce: Database,
  google_ads: Megaphone,
  microsoft_ads: Megaphone,
  meta: Share2,
  linkedin_ads: Briefcase,
  ga4: LineChart,
  search_console: Search,
  semrush: Users,
  call_tracking: PhoneCall,
};

export default async function Connections({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canManageConnections);

  const [connections, reconciliation] = await Promise.all([
    connectionHealth(session),
    reconciliationBySource(session),
  ]);

  const live = connections.filter((c) => c.status === 'healthy' || c.status === 'degraded');
  const waiting = connections.filter((c) => c.status === 'waiting_on_client');
  const unconfigured = connections.filter((c) => c.status === 'not_configured');

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Connections">
        <PrintButton />
      </TopBar>

      <Grid>
        <Card span={12} className="!shadow-none !border-0 !bg-transparent">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{formatCount(live.length)} reporting</Badge>
            <Badge tone="neutral">{formatCount(waiting.length)} waiting on client</Badge>
            <Badge tone="neutral">{formatCount(unconfigured.length)} not configured</Badge>
          </div>
        </Card>

        {connections.map((connection) => (
          <ConnectionTile
            key={connection.id}
            connection={connection}
            slug={slug}
            canSync={canAdministerTenant(session.tenant.role)}
            timezone={session.tenant.timezone}
            checks={reconciliation.get(connection.platform === 'aloware' ? 'call_tracking' : connection.platform) ?? []}
          />
        ))}
      </Grid>
    </>
  );
}

function ConnectionTile({
  connection,
  slug,
  canSync,
  timezone,
  checks,
}: {
  connection: ConnectionCard;
  slug: string;
  canSync: boolean;
  timezone: string;
  /** The latest reconciliation checks for this source, from the daily job. */
  checks: ReconciliationRow[];
}) {
  const status = STATUS[connection.status] ?? { label: connection.status, tone: 'neutral' as const };
  const syncable = SYNCABLE.has(connection.platform);
  const Icon = ICONS[connection.platform] ?? Plug;

  return (
    <Card span={4} interactive>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-primary-100 text-primary-600"
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            {connection.label}
          </span>
        }
        controls={<Badge tone={status.tone}>{status.label}</Badge>}
      />

      <CardBody className="flex-1">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <dt className="text-[12px] text-text-3">Last sync</dt>
            <dd className="text-[13px] tabular text-text">
              {connection.lastSyncAt
                ? connection.lastSyncAt.toLocaleString('en-US', {
                    timeZone: timezone,
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'Never'}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] text-text-3">Rows ingested</dt>
            <dd className="flex items-center gap-1.5 text-[13px] tabular text-text">
              {connection.rowsWritten === null ? '—' : formatCount(connection.rowsWritten)}
              {connection.lastSyncStatus && connection.lastSyncStatus !== 'succeeded' && (
                <InfoTip label="What the last run reported" align="end">
                  The most recent finished run reported {connection.lastSyncStatus}. A run that
                  failed recently is more useful to see than one that succeeded a week ago.
                </InfoTip>
              )}
            </dd>
          </div>
        </dl>

        {connection.detail ? (
          <p className="mt-3 flex items-start gap-1.5 text-[13px] leading-snug text-text-2">
            <span className="line-clamp-2">{firstSentence(connection.detail)}</span>
            <InfoTip label={`Detail for ${connection.label}`} align="end">
              {connection.detail}
              {connection.since
                ? ` Outstanding since ${connection.since.toISOString().slice(0, 10)}.`
                : ''}
            </InfoTip>
          </p>
        ) : connection.status === 'not_configured' ? (
          <div className="mt-3">
            <EmptyLine
              action={
                <span className="inline-flex items-center gap-1 font-medium text-text-2">
                  <Database aria-hidden="true" className="h-3.5 w-3.5" />
                  Add them per client, never by redeploy
                </span>
              }
            >
              Credentials have not been supplied.
            </EmptyLine>
          </div>
        ) : null}

        <Reconciled checks={checks} label={connection.label} timezone={timezone} />
      </CardBody>

      {canSync && syncable && (
        <div className="border-t border-border px-5 py-3 print-hidden">
          <SyncNowButton slug={slug} platform={connection.platform} />
        </div>
      )}
    </Card>
  );
}

/**
 * How our figures compare with the source's own, from the daily job.
 *
 * Matching is one neutral line; drift is an amber badge and a line per
 * disagreeing check naming the window and the days or records — "Sep spend
 * $590 below Meta · not read 19–20 Sep" is the answer, not a red tile.
 */
function Reconciled({
  checks,
  label,
  timezone,
}: {
  checks: ReconciliationRow[];
  label: string;
  timezone: string;
}) {
  if (checks.length === 0) return null;
  const off = checks.filter((c) => c.status === 'drift' || c.status === 'error');
  const explained = checks.filter((c) => c.status === 'explained');
  const through = checks.reduce((max, c) => (c.windowEnd > max ? c.windowEnd : max), '');
  const checkedAt = checks.reduce((max, c) => (c.checkedAt > max ? c.checkedAt : max), checks[0]!.checkedAt);
  const when = checkedAt.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-3">
        <span className="font-medium text-text-2">Reconciled</span>
        {off.length > 0 ? <Badge tone="warn">Drift</Badge> : null}
        <span>checked {when}</span>
      </p>
      {off.length === 0 ? (
        <p className="mt-1 text-[13px] leading-snug text-text-2">
          Matches {label} through {formatRangeLabel({ start: through, end: through })}
          {explained.length > 0 ? ` · ${explained.length} difference${explained.length === 1 ? '' : 's'} explained by recorded corrections` : ''}.
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-[13px] leading-snug text-text-2">
          {off.slice(0, 3).map((c) => (
            <li key={`${c.metric}-${c.windowStart}`}>
              <span className="tabular">
                {formatRangeLabel({ start: c.windowStart, end: c.windowEnd })} · {c.metric.replace(/_/g, ' ')}
                {c.ours !== null && c.theirs !== null ? ` ${formatCount(c.ours)} vs ${formatCount(c.theirs)}` : ''}
              </span>
              {c.detail ? <span className="text-text-3"> · {c.detail}</span> : null}
            </li>
          ))}
          {off.length > 3 ? <li className="text-text-3">and {off.length - 3} more</li> : null}
        </ul>
      )}
    </div>
  );
}

/**
 * The first sentence of a reason, for the one-line row.
 *
 * Splits on a full stop followed by whitespace, not on any full stop: the
 * reasons in this product are full of Salesforce API names, and a naive split
 * turns "Opportunity.csbs__Decline_Reason__c does not exist in the org" into
 * "Opportunity." Falls back to the whole text when there is no break.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^.*?[.!?](?=\s|$)/s.exec(trimmed);
  const sentence = match?.[0] ?? trimmed;
  // A "sentence" of a few characters is an abbreviation, not a sentence.
  return sentence.length < 24 ? trimmed : sentence;
}
