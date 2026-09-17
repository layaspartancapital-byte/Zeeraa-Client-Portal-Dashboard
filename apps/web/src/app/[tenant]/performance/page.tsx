import { trailingWindow, tenantDay, type AttributionModel } from '@zeeraa/core';
import { Panel, EmptyState } from '@/components/Panel';
import { PerformanceTable } from '@/components/PerformanceTable';
import { monthlyPerformance } from '@/lib/reporting';
import { requireTenant } from '@/lib/tenant';

export const metadata = { title: 'Monthly performance' };

const MODELS: { key: AttributionModel; label: string }[] = [
  { key: 'last_touch', label: 'Last touch' },
  { key: 'first_touch', label: 'First touch' },
];

/**
 * The workhorse reporting screen.
 *
 * One row per channel, an explicit unattributed row that is not a channel, and
 * a totals row that renders nothing where a total would be a category error.
 * See `docs/brief-amendments.md`, "§9.2 and §12 — the separation rule is a
 * layout rule too".
 */
export default async function Performance({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ model?: string; days?: string }>;
}) {
  const { tenant: slug } = await params;
  const { model: modelParam, days: daysParam } = await searchParams;
  const session = await requireTenant(slug);

  const model: AttributionModel = modelParam === 'first_touch' ? 'first_touch' : 'last_touch';
  const days = Number(daysParam) > 0 ? Math.min(Number(daysParam), 365) : 90;

  const today = tenantDay(new Date(), session.tenant.timezone);
  const range = trailingWindow(today, days);

  const data = await monthlyPerformance(session, range, model);
  const hasAnything =
    data.channels.length > 0 || Object.keys(data.unattributed.stages).length > 0;

  return (
    <div className="space-y-6">
      <Panel
        title="Monthly performance"
        description={`${range.start} to ${range.end}, in ${session.tenant.timezone}.`}
        aside={
          data.dataThrough
            ? `Data through ${data.dataThrough.toISOString().slice(0, 16).replace('T', ' ')} UTC`
            : 'No completed sync'
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule px-5 py-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-graphite">Attribution model</span>
            {MODELS.map((m) => (
              <a
                key={m.key}
                href={`?model=${m.key}&days=${days}`}
                aria-current={m.key === model ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 ${
                  m.key === model ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {m.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-graphite">Window</span>
            {[30, 90, 365].map((d) => (
              <a
                key={d}
                href={`?model=${model}&days=${d}`}
                aria-current={d === days ? 'true' : undefined}
                className={`rounded-[4px] px-2 py-1 tabular-nums ${
                  d === days ? 'bg-ink text-paper' : 'text-graphite hover:text-ink'
                }`}
              >
                {d} days
              </a>
            ))}
          </div>
        </div>

        {hasAnything ? (
          <PerformanceTable data={data} currency={session.tenant.currency} />
        ) : (
          <EmptyState
            heading="No platform has reported in this window"
            body="This table reports spend, impressions, clicks, CTR, CPC and every funnel stage through to funded volume, per channel, with an explicit row for deals no channel can claim."
            needed="At least one ad platform connection and one completed sync covering this period."
          />
        )}
      </Panel>

      <Panel
        title="Charts"
        description="Spend and funded deals over time; cost per funded deal by channel against target; stage composition; month-over-month change."
      >
        <EmptyState
          heading="Not built yet"
          body="These four charts read the same query as the table above and refresh on window focus. They are the next thing on this screen."
          needed="Nothing from the client — this is Zeeraa's build work."
        />
      </Panel>
    </div>
  );
}
