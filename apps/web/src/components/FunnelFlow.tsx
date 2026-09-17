import { formatCount, formatRate, stageConversionRate, type StageReach } from '@zeeraa/core';
import type { MonthlyPerformance, StageCounts } from '@/lib/reporting';

/**
 * The stage flow, with the conversion rate in the gap between stages.
 *
 * The gaps are the diagnosis, so they carry the number. Three things are
 * deliberately not smoothed over:
 *
 *   - A rate into or out of a stage nobody measures is not a low rate. It is no
 *     rate, and renders as one.
 *   - A rate that crosses a grain boundary — inbound leads into applications —
 *     is marked, because it is a different kind of statement from a rate inside
 *     one grain and comparing the two is a category error.
 *   - Where a blocked stage sits between two measured ones, the transition that
 *     *can* be measured is shown beneath the flow rather than left out. A gap in
 *     the instrumentation is not a gap in the funnel.
 *
 * Both halves of every rate come from the same population. The caller picks the
 * population; this component never mixes one.
 */

function reachFrom(
  stages: MonthlyPerformance['stages'],
  counts: StageCounts,
): StageReach[] {
  return stages.map((stage) => ({
    stage: stage.key,
    count: counts[stage.key] ?? 0,
    origin: 'observed' as const,
  }));
}

export function FunnelFlow({
  data,
  counts,
  populationLabel,
}: {
  data: MonthlyPerformance;
  counts: StageCounts;
  /** Whose funnel this is. Named, so no rate is read as everybody's. */
  populationLabel: string;
}) {
  const { stages, stageStatus } = data;
  const reach = reachFrom(stages, counts);
  const measurable = stages.filter((s) => !stageStatus[s.key]?.blocked);

  // Transitions between stages that are actually measured, skipping any blocked
  // stage in between. Where nothing is skipped this is just the adjacent rate.
  const bridged = measurable.slice(0, -1).map((from, i) => {
    const to = measurable[i + 1]!;
    const skipped = stages
      .filter((s) => s.position > from.position && s.position < to.position)
      .map((s) => s.label);
    return {
      rate: stageConversionRate(reach, from.key, to.key),
      from,
      to,
      skipped,
      crossesGrain: from.source !== to.source,
    };
  });

  return (
    <div>
      <div className="table-scroll overflow-x-auto">
        <div className="flex min-w-max items-stretch px-5 py-6">
          {stages.map((stage, i) => {
            const blocked = stageStatus[stage.key]?.blocked;
            const next = stages[i + 1];
            const nextBlocked = next ? Boolean(stageStatus[next.key]?.blocked) : false;
            const rate = next ? stageConversionRate(reach, stage.key, next.key) : null;
            const crossesGrain = next ? stage.source !== next.source : false;

            return (
              <div key={stage.key} className="flex items-stretch">
                <div className="min-w-[124px] max-w-[164px]">
                  <p
                    className={`pb-1 text-[13px] ${blocked ? 'text-graphite' : 'text-ink'} ${
                      stage.isOptimizationTarget && !blocked ? 'border-b-2 border-brass' : ''
                    }`}
                  >
                    {stage.label}
                  </p>
                  {blocked ? (
                    <p className="mt-2 text-[15px] text-provisional">Not measured</p>
                  ) : (
                    <p className="mt-2 text-[15px] text-ink tabular-nums">
                      {formatCount(counts[stage.key] ?? 0)}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-graphite">
                    {stage.source === 'leads' ? 'inbound leads' : 'opportunities'}
                    {stage.isOptimizationTarget && ' · target'}
                  </p>
                </div>

                {next && (
                  <div className="flex w-24 shrink-0 flex-col items-center justify-start pt-0.5 text-graphite">
                    {blocked || nextBlocked ? (
                      <>
                        <span className="text-[11px]">·</span>
                        <span className="mt-1 text-center text-[10px]">not measurable</span>
                      </>
                    ) : (
                      <>
                        <span className="text-[12px] text-ink tabular-nums">
                          {rate?.rate === null ? '—' : formatRate(rate!.rate!)}
                        </span>
                        <span className="mt-1 text-center text-[10px] tabular-nums">
                          {formatCount(rate?.numerator ?? 0)} of {formatCount(rate?.denominator ?? 0)}
                        </span>
                        {crossesGrain && (
                          <span className="mt-1 text-center text-[10px] text-provisional">
                            leads → opportunities
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-rule px-5 py-4">
        <p className="text-[12px] text-ink">Measured transitions · {populationLabel}</p>
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-graphite">
          Both halves of every rate below come from {populationLabel.toLowerCase()}. A channel&rsquo;s
          rate is never its own numerator over everybody&rsquo;s denominator.
        </p>
        <ul className="mt-3 space-y-1.5">
          {bridged.map((b) => (
            <li key={`${b.from.key}-${b.to.key}`} className="text-[12px] tabular-nums">
              <span className="text-graphite">
                {b.from.label} → {b.to.label}
              </span>{' '}
              <span className="text-ink">
                {b.rate.rate === null ? '—' : formatRate(b.rate.rate)}
              </span>{' '}
              <span className="text-graphite">
                · {formatCount(b.rate.numerator)} of {formatCount(b.rate.denominator)}
              </span>
              {b.skipped.length > 0 && (
                <span className="text-provisional"> · over {b.skipped.join(', ')}, not measured</span>
              )}
              {b.crossesGrain && (
                <span className="text-provisional"> · crosses lead → opportunity grain</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
