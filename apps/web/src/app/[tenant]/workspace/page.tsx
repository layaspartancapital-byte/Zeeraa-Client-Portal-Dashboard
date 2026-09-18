import { MessageSquare, Upload } from 'lucide-react';
import { canUploadAssets, formatCount } from '@zeeraa/core';
import { Card, CardBody, CardHeader, EmptyLine, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { TopBar } from '@/components/shell/TopBar';
import { PrintButton } from '@/components/shell/actions';
import {
  unreadNotifications,
  workspaceBoard,
  type WorkspaceCard as CardData,
} from '@/lib/dashboard';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Workspace' };

/**
 * Content and approvals, as a board grouped by review status.
 *
 * The columns are drawn from the `asset_status` enum rather than from the rows
 * that happen to exist, so the board shows the review path even while it is
 * empty — which it is: uploads, versioning, mentions and the approval flow are
 * phase 5. What renders today is the shell that phase will fill, with the
 * configured asset types and the real (zero) row counts. Nothing here invents
 * a card.
 */
export default async function Workspace({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireTenant(slug);

  const [board, unread] = await Promise.all([
    workspaceBoard(session),
    unreadNotifications(session),
  ]);

  const canUpload = canUploadAssets(session.tenant.role);

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="Workspace" unread={unread}>
        <PrintButton />
      </TopBar>

      <Grid>
        <Card span={8}>
          <CardHeader
            title="Add work"
            subtitle={
              canUpload
                ? 'Link an asset to a commitment and a period as it goes up'
                : 'Zeeraa uploads work here for review'
            }
            info={
              <InfoTip label="How uploads work" align="start">
                An asset is stored under a blob key prefixed with this client&rsquo;s tenant id and
                served only through a signed, authorisation-checked URL. Approving one is what
                turns it into evidence behind a delivery count.
              </InfoTip>
            }
          />
          <CardBody className="flex-1">
            <div className="flex min-h-[112px] flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-canvas px-4 py-6 text-center">
              <Upload aria-hidden="true" className="h-5 w-5 text-text-3" />
              <EmptyLine
                className="justify-center"
                href={`/${slug}/delivery`}
                action="See the commitments they attach to"
              >
                Uploads arrive with phase 5.
              </EmptyLine>
            </div>
          </CardBody>
        </Card>

        <Card span={4}>
          <CardHeader title="Activity" subtitle="Uploads, comments, approvals" />
          <CardBody className="flex-1">
            <EmptyLine>Nothing has happened in this workspace yet.</EmptyLine>
          </CardBody>
        </Card>

        <Card span={12}>
          <CardHeader
            title="Content and approvals"
            subtitle={`${formatCount(board.total)} ${
              board.total === 1 ? 'asset' : 'assets'
            } · ${formatCount(board.types.length)} asset types configured`}
          />
          <CardBody flush>
            <div className="scroll-x min-w-0 overflow-x-auto px-5 pb-1">
              <ul className="flex min-w-[720px] gap-4">
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
                            <BoardCard key={card.id} card={card} />
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
            <ul className="flex flex-wrap gap-2">
              {board.types.map((type) => (
                <li key={type.key}>
                  <Badge tone="neutral">{type.label}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </Grid>
    </>
  );
}

function BoardCard({ card }: { card: CardData }) {
  return (
    <li className="card card-lift !rounded-[8px] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <Badge tone="primary">{card.typeLabel}</Badge>
        <span className="shrink-0 text-[12px] tabular text-text-3">v{card.version}</span>
      </div>
      <p className="mt-1.5 text-[13px] font-medium leading-snug text-text">{card.title}</p>
      {card.commitmentLabel && (
        <p className="mt-0.5 truncate text-[12px] text-text-2">{card.commitmentLabel}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
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
      </div>
    </li>
  );
}
