import { Download, ExternalLink, MessageSquare } from 'lucide-react';
import { canApproveAssets, canUploadAssets, formatCount, tenantDay } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import { UploadForm } from '@/components/workspace/UploadForm';
import { ReviewActions } from '@/components/workspace/ReviewActions';
import {
  unreadNotifications,
  workspaceBoard,
  type WorkspaceCard as CardData,
} from '@/lib/dashboard';
import { storageConfig } from '@/lib/storage';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Workspace' };

/**
 * Content and approvals, as a board grouped by review status.
 *
 * This is where a delivered figure comes from. Zeeraa uploads a piece of work
 * tagged to one of the client's configured commitments and a period; the client
 * approves it or sends it back; approved, unsuperseded artifacts are what the
 * delivery view counts. Nothing else on this screen moves a number.
 *
 * The columns are drawn from the `asset_status` enum rather than from the rows
 * that happen to exist, so the review path is visible even where a column is
 * empty.
 */
export default async function Workspace({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);
  const today = tenantDay(new Date(), session.tenant.timezone);

  const [board, unread] = await Promise.all([
    workspaceBoard(session),
    unreadNotifications(session),
  ]);

  const canUpload = canUploadAssets(session.tenant.role);
  const canDecide = canApproveAssets(session.tenant.role);
  const storageReady = storageConfig() !== null;

  const replaceable = board.columns
    .find((c) => c.status === 'changes_requested')
    ?.cards.filter((c) => !c.superseded)
    .map((c) => ({
      id: c.id,
      title: c.title,
      commitmentKey: c.commitmentKey,
      version: c.version,
    }));

  const uploadBlocked = !canUpload
    ? 'Zeeraa uploads work here for the client to review.'
    : !storageReady
      ? 'Asset storage is not configured on this deployment yet.'
      : null;

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Workspace" unread={unread}>
        <PrintButton />
      </TopBar>

      <Grid>
        <Card span={12}>
          <CardHeader
            title="Add work"
            subtitle={
              canUpload
                ? 'Tagged to a commitment and a period as it goes up'
                : 'Zeeraa uploads work here for review'
            }
            info={
              <InfoTip label="How an upload becomes a delivered figure" align="start">
                A file is stored under a key prefixed with this client&rsquo;s tenant id and is
                reachable only through a signed, authorisation-checked link. Approved artifacts,
                latest version only, are what the delivery view counts.
              </InfoTip>
            }
            controls={
              !storageReady && canUpload ? <Badge tone="warn">Storage not configured</Badge> : null
            }
          />
          <CardBody>
            <UploadForm
              slug={slug}
              types={board.types}
              commitments={board.commitments}
              today={today}
              replaceable={replaceable ?? []}
              disabledReason={uploadBlocked}
            />
          </CardBody>
        </Card>

        <Card span={12}>
          <CardHeader
            title="Content and approvals"
            subtitle={`${formatCount(board.total)} ${
              board.total === 1 ? 'asset' : 'assets'
            } · ${formatCount(board.commitments.length)} commitments they can be tagged to`}
          />
          <CardBody flush>
            <div className="scroll-x min-w-0 overflow-x-auto px-5 pb-1">
              <ul className="flex min-w-[880px] gap-4">
                {board.columns.map((column) => (
                  <li key={column.status} className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 pb-2">
                      <p className="truncate text-[13px] font-semibold text-text">{column.label}</p>
                      <span className="shrink-0 text-[12px] tabular text-text-3">
                        {formatCount(column.cards.length)}
                      </span>
                    </div>
                    <div className="min-h-[132px] rounded-[8px] bg-canvas p-2">
                      {column.cards.length === 0 ? (
                        <p className="px-1 py-2 text-[12px] text-text-3">Empty</p>
                      ) : (
                        <ul className="space-y-2">
                          {column.cards.map((card) => (
                            <BoardCard
                              key={card.id}
                              card={card}
                              slug={slug}
                              canDecide={canDecide}
                              canSubmit={canUpload}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>

        <Card span={12}>
          <CardHeader
            title="Asset types"
            subtitle="Per-client configuration, never an enum in code"
          />
          <CardBody>
            {board.types.length === 0 ? (
              <EmptyLine>No asset type is configured for this client.</EmptyLine>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {board.types.map((type) => (
                  <li key={type.key}>
                    <Badge tone="neutral">{type.label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </Grid>
    </>
  );
}

function BoardCard({
  card,
  slug,
  canDecide,
  canSubmit,
}: {
  card: CardData;
  slug: string;
  canDecide: boolean;
  canSubmit: boolean;
}) {
  return (
    <li className="card !rounded-[8px] px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* The type label is per-tenant configuration and can be long
            ("Landing page design or spec"); it truncates rather than pushing
            the version out of the card. */}
        <div className="min-w-0 flex-1">
          <Badge tone="primary" className="min-w-0 max-w-full" title={card.typeLabel}>
            <span className="min-w-0 truncate">{card.typeLabel}</span>
          </Badge>
        </div>
        <span className="shrink-0 text-[12px] tabular text-text-3">v{card.version}</span>
      </div>
      <p className="mt-1.5 text-[13px] font-medium leading-snug text-text">{card.title}</p>

      {card.commitmentLabel && (
        <p className="mt-0.5 truncate text-[12px] text-text-2">
          {card.commitmentLabel}
          {card.periodLabel && <span className="text-text-3"> · {card.periodLabel}</span>}
        </p>
      )}

      {card.superseded && (
        <p className="mt-1.5">
          <Badge tone="neutral">
            Superseded
            <InfoTip label="Why this version counts toward nothing" align="center">
              A later version of this asset replaces it. Only the latest version of a piece of
              work counts, so one article approved twice is one article delivered.
            </InfoTip>
          </Badge>
        </p>
      )}

      {card.status === 'changes_requested' && card.changesRequestedReason && (
        <p className="mt-1.5 rounded-[6px] bg-canvas px-2 py-1.5 text-[12px] leading-snug text-text-2">
          {card.changesRequestedReason}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {card.assigneeName && (
          <span
            aria-hidden="true"
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-100 text-[10px] font-semibold text-primary-600"
            title={card.assigneeName}
          >
            {card.assigneeName.trim()[0]?.toUpperCase()}
          </span>
        )}
        <span className="flex items-center gap-1 text-[12px] tabular text-text-3">
          <MessageSquare aria-hidden="true" className="h-3 w-3" />
          {formatCount(card.comments)}
        </span>
        {card.hasFile && (
          <a
            href={`/api/assets/${slug}/${card.id}/file`}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:text-primary-600"
          >
            <Download aria-hidden="true" className="h-3 w-3" />
            {card.fileName ?? 'File'}
          </a>
        )}
        {!card.hasFile && card.externalUrl && (
          <a
            href={card.externalUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:text-primary-600"
          >
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
            Live
          </a>
        )}
      </div>

      {/* The audit trail that settles "we never signed off on that". */}
      {card.approvedByName && card.approvedAt && (
        <p className="mt-1.5 text-[12px] text-text-3">
          Approved by {card.approvedByName} on {stamp(card.approvedAt)}
        </p>
      )}
      {card.status === 'changes_requested' && card.changesRequestedByName && card.changesRequestedAt && (
        <p className="mt-1.5 text-[12px] text-text-3">
          Sent back by {card.changesRequestedByName} on {stamp(card.changesRequestedAt)}
        </p>
      )}

      <ReviewActions
        slug={slug}
        assetId={card.id}
        canDecide={canDecide}
        canSubmit={canSubmit}
        status={card.status}
        superseded={card.superseded}
      />
    </li>
  );
}

function stamp(date: Date): string {
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
