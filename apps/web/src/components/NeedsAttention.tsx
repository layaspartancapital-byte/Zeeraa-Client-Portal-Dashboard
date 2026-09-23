import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Card, CardBody, CardHeader, EmptyLine } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';

/**
 * How loudly a finding is drawn.
 *
 * `act` is something somebody should do this week; `watch` is a fact worth
 * knowing that nobody is failing at. There is no third, angrier level: a
 * briefing that shouts cannot be read, and the screens in this product are a
 * record rather than an alarm panel.
 */
export type FindingLevel = 'act' | 'watch';

export type Finding = {
  key: string;
  level: FindingLevel;
  /** The finding itself, in one line. Never a metric name on its own. */
  headline: string;
  /** The figure the headline turns on, already formatted. */
  figure: string;
  /** One line of context. Two at most, and never a paragraph. */
  detail: string;
  /** The methodology or caveat, where one is needed. */
  note?: string;
  /** Where to go to act on it. */
  action?: { label: string; href: string };
};

/**
 * What a reader should do something about, as findings rather than as metrics.
 *
 * The distinction is the whole point of the card. A metric is "speed to lead:
 * 10h 18m"; a finding is "leads wait ten hours for a first call, and 15.7% are
 * reached inside five minutes". The first is a number somebody has to interpret
 * and the second is the interpretation — which is the thing an account director
 * would otherwise write in an email, and the thing a briefing exists to
 * replace.
 *
 * Nothing here is generated from a threshold nobody agreed. Each finding is
 * either a fact about configuration (campaigns paused, a connector degraded) or
 * a measured figure stated with its population. Where a bar is applied — the
 * five-minute one — it is the industry's own and is named as such.
 *
 * An empty card is a real state and says so in one line. It is not an
 * achievement and does not get a celebration: these screens are a record, not a
 * report card.
 */
export function NeedsAttention({
  findings,
  span = 8,
}: {
  findings: Finding[];
  span?: 6 | 8 | 12;
}) {
  const act = findings.filter((f) => f.level === 'act').length;

  return (
    <Card span={span} selfStart>
      <CardHeader
        title="Needs attention"
        subtitle="Findings, not figures"
        controls={
          findings.length === 0 ? undefined : act > 0 ? (
            <Badge tone="warn">{act} to act on</Badge>
          ) : (
            <Badge tone="neutral">{findings.length} to watch</Badge>
          )
        }
      />

      <CardBody className="flex-1">
        {findings.length === 0 ? (
          <EmptyLine>Nothing is outstanding against the checks this screen runs.</EmptyLine>
        ) : (
          <ul className="flex flex-col">
            {findings.map((finding) => (
              <li
                key={finding.key}
                className="flex items-start gap-3 border-b border-border/60 py-3 first:pt-0 last:border-0 last:pb-0"
              >
                <span
                  aria-hidden="true"
                  className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${
                    finding.level === 'act' ? 'bg-[#DC6803]' : 'bg-[#98A2B3]'
                  }`}
                />

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium text-text">
                    <span className="min-w-0">{finding.headline}</span>
                    <span className="tabular text-text-2">{finding.figure}</span>
                    {finding.note && (
                      <InfoTip label={`About ${finding.headline}`} align="start">
                        {finding.note}
                      </InfoTip>
                    )}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-snug tabular text-text-2">
                    {finding.detail}
                  </p>
                </div>

                {finding.action && (
                  <Link
                    href={finding.action.href}
                    className="mt-[2px] link inline-flex shrink-0 items-center gap-1 text-[13px] print-hidden"
                  >
                    {finding.action.label}
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Link>
                )}

                <span className="sr-only">
                  {finding.level === 'act' ? 'Act on this.' : 'Watch this.'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
