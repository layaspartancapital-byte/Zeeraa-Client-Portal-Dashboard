import { Card, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import type { DataQualityItem } from '@/lib/dashboard';

/**
 * The one card where blocked items are listed in full (spec v2 §6).
 *
 * Every screen that depends on something the platform cannot currently measure
 * carries this card, and nothing else on that screen explains itself: a blocked
 * stage in a table or a funnel is an amber badge with the reason in its
 * tooltip, and the row here is where it is written down with its date.
 *
 * A missing data dependency is a state, not a gap. A visible dependency is a
 * conversation; a silent one looks like the agency failed.
 */

const LABELS: Record<DataQualityItem['status'], { text: string; tone: BadgeTone }> = {
  not_measured: { text: 'Not measured', tone: 'warn' },
  degraded: { text: 'Degraded', tone: 'warn' },
  waiting_on_client: { text: 'Waiting on client', tone: 'neutral' },
  unreconciled: { text: 'Unreconciled', tone: 'neutral' },
  not_configured: { text: 'Not configured', tone: 'neutral' },
};

export function DataQualityCard({
  items,
  span = 4,
  title = 'Data quality',
}: {
  items: DataQualityItem[];
  span?: 3 | 4 | 6 | 8 | 12;
  title?: string;
}) {
  return (
    <Card span={span}>
      <CardHeader
        title={title}
        subtitle={
          items.length === 0
            ? 'Nothing outstanding'
            : `${items.length} ${items.length === 1 ? 'item' : 'items'} the platform cannot measure yet`
        }
      />
      {items.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyLine>Every configured stage and connection is reporting.</EmptyLine>
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {items.map((item) => {
            const label = LABELS[item.status];
            return (
              <li key={item.key} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-text">{item.name}</span>
                    <InfoTip label={`Why ${item.name} is ${label.text.toLowerCase()}`} align="start">
                      {item.detail || item.summary}
                    </InfoTip>
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-text-2">{item.summary}</p>
                  {item.since && (
                    <p className="mt-0.5 text-[12px] text-text-3 tabular">
                      since {item.since.toISOString().slice(0, 10)}
                    </p>
                  )}
                </div>
                <Badge tone={label.tone}>{label.text}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
