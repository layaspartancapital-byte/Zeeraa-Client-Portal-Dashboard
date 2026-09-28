import { INTEGRATION_PREVIEWS, PENDING_STATE_LABELS, type PendingPlatformState } from '@zeeraa/core';
import { Card, CardBody, Grid } from '@/components/ui/Card';
import { TopBar } from '@/components/shell/TopBar';
import type { TenantSession } from '@/lib/tenant';

/**
 * A platform being connected (`integrating_platforms`) that has not reported
 * yet. Its name, that the integration is in progress, and one line on what the
 * page will show — and nothing else: no figure, no chart and no zero, because
 * nothing has been read and a zero would be a measurement. The day the
 * platform reports, the same URL renders its ordinary page.
 */
export function IntegratingPlatformView({
  session,
  label,
  platform,
  state = 'integrating',
}: {
  session: TenantSession;
  label: string;
  platform: string;
  /** `connected`: the grant works and no campaign has spent. Still no figure. */
  state?: PendingPlatformState;
}) {
  const preview = INTEGRATION_PREVIEWS[platform] ?? `What ${label} reports, once it is connected.`;
  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title={label} />
      <Grid>
        <Card span={12}>
          <CardBody>
            <div className="flex flex-col items-start gap-2 py-6">
              <p className="text-[18px] font-semibold text-text">{label}</p>
              <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2">
                <span
                  aria-hidden="true"
                  className={`block h-1.5 w-1.5 rounded-full bg-text-3 ${
                    state === 'integrating' ? 'motion-safe:animate-[integrating_2.4s_ease-in-out_infinite]' : ''
                  }`}
                />
                {state === 'connected' ? PENDING_STATE_LABELS.connected : 'Integration in progress'}
              </p>
              <p className="text-[13px] text-text-2">
                {state === 'connected' ? 'From the first campaign that spends: ' : 'Once connected: '}
                {preview.charAt(0).toLowerCase() + preview.slice(1)}
              </p>
            </div>
          </CardBody>
        </Card>
      </Grid>
    </>
  );
}
