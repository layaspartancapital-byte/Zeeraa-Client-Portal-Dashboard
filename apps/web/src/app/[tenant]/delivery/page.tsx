import { Download, Paperclip, PencilLine } from 'lucide-react';
import { formatCount, formatRate, tenantDay } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { Progress, Ring } from '@/components/ui/Progress';
import { MethodDrawer, MethodNotesForPrint, type MethodNote } from '@/components/ui/Drawer';
import { PageMeta, TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { KpiCard } from '@/components/KpiCard';
import { deliveryStatus, unreadNotifications, type CommitmentRow } from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Delivery' };

const NOT_RECORDED =
  'No delivery record has been written for this period. A count appears once an artifact is ' +
  'in front of the client in the workspace, or where a count is recorded by hand because the ' +
  'commitment produces no artifact. That is not a delivery of none.';

const HOW_DELIVERED =
  'Approved artifacts, latest version only. Where a commitment produces no artifact — ' +
  'backlinks, tracked prompts, concurrent tests — the count is recorded by hand instead.';

/**
 * A compliance record, not an achievement.
 *
 * No checkmarks and no celebration: the client is paying for this, and treating
 * delivery as a triumph reads badly. Tone is neutral throughout, and a
 * commitment nobody has recorded against renders as `Not recorded` rather than
 * as `0 of 20` — a zero is a measurement, and "we have not written this down
 * yet" is the opposite of one.
 */
export default async function Delivery({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);
  const today = tenantDay(new Date(), session.tenant.timezone);

  const [delivery, unread] = await Promise.all([
    deliveryStatus(session, today),
    unreadNotifications(session),
  ]);

  const monthly = delivery.commitments.filter((c) => c.period === 'monthly');
  const recorded = delivery.commitments.filter((c) => c.delivered !== null);
  const met = recorded.filter((c) => c.delivered! >= c.committed);

  const slasMeasured = delivery.slas.filter((s) => s.compliance !== null);
  const slaCompliance =
    slasMeasured.length === 0
      ? null
      : slasMeasured.reduce((sum, s) => sum + s.compliance!, 0) / slasMeasured.length;

  const notes: MethodNote[] = [
    {
      heading: 'Committed and delivered',
      body: NOT_RECORDED,
      detail: `${delivery.commitments.length} commitments are configured for this client; ${recorded.length} have a record for ${delivery.periodLabel}.`,
    },
    {
      heading: 'Where a delivered count comes from',
      body: HOW_DELIVERED,
      detail:
        'The two are alternatives and are never added together. Where artifacts exist they ' +
        'decide the figure, and a hand-recorded count that disagrees is stated beside it rather ' +
        'than folded in. Only the client can approve, so the figure is not one Zeeraa can raise ' +
        'on its own behalf, and a superseded version counts toward nothing — one article ' +
        'approved twice is one article delivered.',
    },
    {
      heading: 'Ranges',
      body:
        'Several commitments are ranges — 30 to 40 backlinks, 2 to 3 concurrent tests. The ' +
        'progress bar measures against the lower bound, which is the commitment; the upper bound ' +
        'is shown beside it.',
    },
    {
      heading: 'Over-delivery',
      body:
        'A bar past 100% extends in the soft tone. The first 100% stays proportional so the bar ' +
        'cannot overstate the fraction it is showing.',
    },
    {
      heading: 'Service levels',
      body:
        'A response-time commitment is met by landing inside the target; a cadence commitment is ' +
        'met by the event happening at all. With no events recorded there is no compliance rate — ' +
        'not a rate of zero.',
    },
  ];

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Delivery" unread={unread}>
        <ButtonLink href={`/api/export/${slug}/delivery`}>
          <Download aria-hidden="true" className="h-4 w-4" />
          Export CSV
        </ButtonLink>
        <PrintButton />
      </TopBar>

      <PageMeta>
        <MethodDrawer notes={notes} title={delivery.periodLabel} />
      </PageMeta>

      <Grid>
        <KpiCard
          label="Commitments met this period"
          value={recorded.length === 0 ? null : `${formatCount(met.length)} of ${formatCount(recorded.length)}`}
          notMeasured={`Nothing recorded for ${delivery.periodLabel}`}
          context={`${formatCount(delivery.commitments.length)} commitments configured`}
          points={[]}
          variant="bars"
          info={NOT_RECORDED}
        />
        <KpiCard
          label="Artifacts approved"
          value={formatCount(delivery.artifactsApproved)}
          context={`${formatCount(recorded.length)} of ${formatCount(delivery.commitments.length)} commitments have a record`}
          points={[]}
          variant="bars"
          info="Approved artifacts in this period, latest version only. Not a sum of the delivered column: those figures are in different units — creatives, pages, links, tracked prompts — and adding them would produce a number nothing measures."
        />
        <KpiCard
          label="SLA compliance"
          value={slaCompliance === null ? null : formatRate(slaCompliance)}
          notMeasured="No service-level event has been recorded"
          context={`${formatCount(delivery.slas.length)} service levels committed`}
          points={[]}
          info="The mean compliance across every service level with an event behind it. A service level with no events has no rate, and is left out rather than counted as zero."
        />
        <KpiCard
          label="Approvals pending"
          value={formatCount(delivery.approvalsPending)}
          context={
            delivery.assetsTotal === 0
              ? 'No asset has been submitted yet'
              : `${formatCount(delivery.assetsTotal)} assets in the workspace`
          }
          points={[]}
          variant="bars"
          info="Assets submitted to the client and awaiting a decision. This is a count of rows in the workspace, so zero here is a measurement rather than an absence."
        />

        <Card span={8}>
          <CardHeader
            title="Committed and delivered"
            subtitle={`${delivery.periodLabel} · monthly commitments, then quarterly`}
          />
          <div className="scroll-x min-w-0 overflow-x-auto border-t border-border">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-semibold text-text-2">
                  <th scope="col" className="px-5 py-2.5 font-semibold">
                    Commitment
                  </th>
                  <th scope="col" className="numeric px-3 py-2.5 font-semibold">
                    Committed
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      Delivered
                      <InfoTip label="How delivered is established" align="center">
                        {HOW_DELIVERED}
                      </InfoTip>
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Period
                  </th>
                  <th scope="col" className="px-5 py-2.5 font-semibold">
                    Approval
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...monthly, ...delivery.commitments.filter((c) => c.period === 'quarterly')].map(
                  (row) => (
                    <CommitmentTableRow key={row.key} row={row} />
                  ),
                )}
              </tbody>
            </table>
          </div>

        </Card>

        <Card span={4}>
          <CardHeader title="Service levels" subtitle="Response times and cadences committed" />
          <ul className="divide-y divide-border border-t border-border">
            {delivery.slas.map((sla) => (
              <li key={sla.type} className="flex items-center gap-3 px-5 py-3">
                <Ring
                  value={sla.compliance}
                  label={
                    sla.compliance === null
                      ? `${sla.label}: no events recorded`
                      : `${sla.label}: ${formatRate(sla.compliance)} compliance`
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-text">{sla.label}</p>
                  <p className="truncate text-[12px] text-text-2 tabular">{sla.commitment}</p>
                </div>
                {sla.compliance === null ? (
                  <Badge tone="warn">Not measured</Badge>
                ) : (
                  <span className="shrink-0 text-[13px] font-semibold tabular text-text">
                    {formatRate(sla.compliance)}
                    <span className="ml-1 text-[12px] font-normal text-text-3">
                      {formatCount(sla.met)}/{formatCount(sla.events)}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {delivery.slas.length === 0 && (
            <CardBody>
              <EmptyLine>No service level is configured for this client.</EmptyLine>
            </CardBody>
          )}
        </Card>
      </Grid>

      <MethodNotesForPrint notes={notes} />
    </>
  );
}

function CommitmentTableRow({ row }: { row: CommitmentRow }) {
  const committedLabel = row.committedMax
    ? `${formatCount(row.committed)}–${formatCount(row.committedMax)}`
    : formatCount(row.committed);

  return (
    <tr className="border-b border-border transition-colors last:border-b-0 hover:bg-canvas">
      <th scope="row" className="px-5 py-3 text-left text-[13px] font-medium text-text">
        {row.label}
      </th>
      <td className="numeric px-3 py-3 tabular text-text">
        {committedLabel}
        <span className="ml-1 text-[12px] text-text-3">{row.unit}</span>
      </td>
      <td className="px-3 py-3">
        {row.delivered === null ? (
          <span className="inline-flex items-center gap-1.5">
            <Badge tone="neutral">Not recorded</Badge>
            <InfoTip label={`Why ${row.label} has no delivered count`} align="center">
              {NOT_RECORDED}
            </InfoTip>
          </span>
        ) : (
          <span className="flex min-w-[170px] items-center gap-2">
            <Progress
              // Measured against the commitment, which for a range is its lower
              // bound. Over-delivery runs past 100% in the soft tone.
              value={row.committed === 0 ? 0 : row.delivered / row.committed}
              label={`${row.label}: ${formatCount(row.delivered)} of ${committedLabel} ${row.unit}`}
            />
            <span className="shrink-0 text-[12px] tabular text-text">
              {formatCount(row.delivered)}/{committedLabel}
            </span>
            {/* Provenance on the figure, not in a footnote: approved artifacts
                and a hand-kept tally are different claims. */}
            <span
              className="shrink-0 text-text-3"
              title={
                row.source === 'derived_from_assets'
                  ? 'From approved artifacts in the workspace'
                  : 'Recorded by hand: this commitment produces no artifact'
              }
            >
              {row.source === 'derived_from_assets' ? (
                <Paperclip aria-label="From approved artifacts" className="h-3.5 w-3.5" />
              ) : (
                <PencilLine aria-label="Recorded by hand" className="h-3.5 w-3.5" />
              )}
            </span>
            {row.recordedByHand !== null && (
              <InfoTip label={`${row.label}: the hand-recorded count differs`} align="center">
                {`${formatCount(row.delivered)} approved ${row.delivered === 1 ? 'artifact stands' : 'artifacts stand'} behind this figure, against ${formatCount(row.recordedByHand)} recorded by hand. The artifacts decide it; the two are never added.`}
              </InfoTip>
            )}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-[13px] text-text-2">
        {row.period === 'monthly' ? 'Monthly' : 'Quarterly'}
      </td>
      <td className="px-5 py-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {row.awaitingApproval > 0 && (
            <Badge tone="warn">{formatCount(row.awaitingApproval)} awaiting approval</Badge>
          )}
          {row.changesRequested > 0 && (
            <Badge tone="neutral">{formatCount(row.changesRequested)} sent back</Badge>
          )}
          {row.awaitingApproval === 0 && row.changesRequested === 0 && (
            row.requiresClientApproval ? (
              <Badge tone="neutral">Client approval required</Badge>
            ) : (
              <span className="text-[13px] text-text-3">—</span>
            )
          )}
        </span>
      </td>
    </tr>
  );
}
