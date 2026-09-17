import { Panel, EmptyState } from '@/components/Panel';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Monthly performance' };

export default async function Performance({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  await requireTenant(slug);

  return (
    <Panel
      title="Monthly performance"
      description="One row per platform, expanding to campaign and then to keyword tier."
    >
      <EmptyState
        heading="No platform has reported yet"
        body="This table reports spend, impressions, clicks, CTR, CPC, leads, qualified leads, submissions and every funnel stage through to funded volume, per platform, for one month."
        needed="At least one ad platform connection and one completed nightly sync."
      />
    </Panel>
  );
}
