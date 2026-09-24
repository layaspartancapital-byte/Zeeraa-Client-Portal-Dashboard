import { formatCount, formatRate, stageConversionRate, type PopulationVerdict, type StageReach } from '@zeeraa/core';
import { NotMeasuredBadge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import type { MonthlyPerformance, StageCounts } from '@/lib/reporting';

/**
 * The funnel: one card per stage, one chip per transition (spec v2 §6).
 *
 * **Every card has the same three rows and every gap says something.** That is
 * the whole design, and both halves of it were learned by getting them wrong.
 *
 * The card used to grow a line per caveat — the grain, the declines, the
 * coverage horizon, the share of leads the bar could be evaluated against —
 * each with its own ⓘ. Seven stages then rendered seven different heights with
 * up to two tooltips apiece, and the funnel stopped reading as a funnel: the
 * eye could not find the numbers among the qualifications. So the card carries
 * a label, a figure and one supporting line, in fixed rows, and **one** ⓘ that
 * holds everything else.
 *
 * The gaps used to render a bare em dash where a ratio was not a conversion
 * rate. Four of Spartan's six transitions are in that state, for four different
 * reasons, and a dash communicated none of them — it reads as missing data,
 * which is the opposite of what it means. A withheld rate is a deliberate
 * refusal and now says so in words, with the specific reason in its ⓘ.
 *
 * Three rules this component exists to keep, all unchanged:
 *
 *   - A stage nobody measures is a dimmed card the same size as the others
 *     with a `Not measured` badge. Never a zero: a zero is a measurement, and
 *     nobody stamping that timestamp in the CRM is the opposite of one.
 *   - Where a blocked stage sits between two measured ones, the chip carries
 *     the transition that *can* be measured, labelled with what it spans. A gap
 *     in the instrumentation is not a gap in the funnel.
 *   - A rate that crosses a grain boundary — inbound leads into opportunities —
 *     says so, because comparing it to a rate inside one grain is a category
 *     error.
 *
 * Both halves of every rate come from the population the caller chose. This
 * component never mixes one.
 */
export function FunnelStages({
  data,
  counts,
  populationLabel,
}: {
  data: MonthlyPerformance;
  counts: StageCounts;
  populationLabel: string;
}) {
  const { stages, stageStatus, qualification, progression } = data;
  const mqlStageKey = stages.find((st) => st.key === 'mql')?.key ?? null;
  const reach: StageReach[] = stages.map((stage) => ({
    stage: stage.key,
    count: counts[stage.key] ?? 0,
    origin: stageStatus[stage.key]?.origin ?? 'observed',
  }));

  const measured = stages.map((s) => !stageStatus[s.key]?.blocked);

  /**
   * The grain of the record a stage is counted from.
   *
   * `qualified_leads` is a narrowing of `leads`, not a different kind of thing,
   * so a rate between them stays inside one grain and carries no caveat.
   */
  const grainOf = (source: string | undefined) =>
    source === 'leads' || source === 'qualified_leads' ? 'lead' : 'opportunity';

  /** What the figure counts. One line, and the same shape on every card. */
  const nounFor = (stage: (typeof stages)[number]) => {
    const base =
      stage.source === 'leads'
        ? 'inbound leads'
        : stage.source === 'qualified_leads'
          ? 'leads past the bar'
          : 'opportunities';
    // `target` is text rather than the blue top border this card used to
    // carry. Colour was the only thing marking an optimisation target, which
    // both left it unexplained and broke the rule that colour is never the
    // only encoding.
    return stage.isOptimizationTarget ? `${base} · target` : base;
  };

  /**
   * Everything that is not the figure, in one tooltip of at most two sentences.
   *
   * Composed in priority order rather than concatenated: a stage can carry a
   * horizon *and* declines *and* a computed origin, and three sentences in a
   * tooltip is a paragraph. The first sentence always says what the number
   * counts, with the origin or horizon folded in as a clause; the second is
   * whichever single caveat matters most.
   */
  const detailFor = (stage: (typeof stages)[number]) => {
    const blocked = stageStatus[stage.key]?.blocked;
    if (blocked) {
      return `${blocked.reason}${blocked.needed ? ` Needed: ${blocked.needed}` : ''}`;
    }

    const coverage = stageStatus[stage.key]?.coverage ?? null;
    const computed = stageStatus[stage.key]?.origin === 'computed';
    const lost = progression[stage.key]?.laterLost ?? 0;
    const reached = progression[stage.key]?.reached ?? 0;

    const what =
      stage.source === 'leads'
        ? `Inbound leads created in this window, counted at lead grain rather than opportunity grain`
        : stage.source === 'qualified_leads'
          ? `Leads meeting the qualification bar, computed from what a lead reported rather than a gate it passes through`
          : `Opportunities reaching ${stage.label} in this window`;

    const clause = coverage
      ? `, read from ${coverage.source}, which begins ${coverage.from
          .toISOString()
          .slice(0, 10)} — anything earlier cannot be read at all`
      : computed && stage.source !== 'qualified_leads'
        ? ', derived by this platform rather than stamped by the CRM'
        : stage.isOptimizationTarget
          ? ', one of the stages this engagement is optimised for'
          : '';

    const first = `${what}${clause}.`;

    // The second sentence, by priority. Declines first: a funnel drawn left to
    // right cannot show a deal going backwards, and here most of them do.
    if (lost > 0) {
      return `${first} ${formatCount(lost)} of the ${formatCount(
        reached,
      )} deals reaching it have a decline recorded afterwards — they are counted here because they did reach the stage, but they are not still in it.`;
    }
    if (stage.key === mqlStageKey && qualification.coverage !== null) {
      return `${first} The bar could be evaluated against ${formatRate(
        qualification.coverage,
      )} of this window's leads; the rest answer in a band that spans the threshold and are neither qualified nor unqualified.`;
    }
    return first;
  };

  /**
   * For a gap that touches a blocked stage, the nearest measured stage on each
   * side — so the chip can carry the rate that survives the hole.
   */
  const bridgeFor = (gap: number) => {
    let from = gap;
    while (from >= 0 && !measured[from]) from -= 1;
    let to = gap + 1;
    while (to < stages.length && !measured[to]) to += 1;
    if (from < 0 || to >= stages.length) return null;
    if (gap !== from) return null;
    return {
      from: stages[from]!,
      to: stages[to]!,
      skipped: stages.slice(from + 1, to).map((s) => s.label),
      rate: stageConversionRate(reach, stages[from]!.key, stages[to]!.key),
    };
  };

  return (
    <div className="px-5 pb-5">
      <div className="flex flex-wrap items-stretch gap-y-4">
        {stages.map((stage, i) => {
          const blocked = stageStatus[stage.key]?.blocked;
          const next = stages[i + 1];
          const bothMeasured = next ? measured[i] && measured[i + 1] : false;
          const bridge = next && !bothMeasured ? bridgeFor(i) : null;
          const ratio =
            next && bothMeasured && (counts[stage.key] ?? 0) > 0
              ? (counts[next.key] ?? 0) / (counts[stage.key] ?? 0)
              : null;

          return (
            <div
              key={stage.key}
              /*
                No `min-w-0`: a stage is its card and the chip after it, and
                it must not shrink below both. With it, the pair was squeezed
                narrower than the card's own minimum plus the chip, and the
                next card drew over the chip — "not gat", "38.2" — at widths
                where the row had not yet wrapped. Its natural minimum makes
                the row wrap first.
              */
              className="flex flex-1 basis-[112px] items-stretch"
            >
              {/*
                Three fixed rows — label, figure, supporting line — so seven
                cards are the same height whatever their content does, and the
                figures sit on one baseline across the whole funnel.
              */}
              <div
                /*
                  `min-w` matters as much as the fixed rows. Left to shrink,
                  a card at 1024px is 73px wide, "opportunities · target" takes
                  three lines, and a wrapped row is 34px taller than the one
                  below it. The row wraps sooner instead.
                */
                className={`flex min-h-[124px] min-w-[104px] flex-1 flex-col rounded-[8px] border px-2.5 pb-3 pt-2.5 ${
                  blocked ? 'border-dashed border-border bg-canvas' : 'border-border bg-surface'
                }`}
              >
                <p
                  className={`flex min-h-[32px] items-start justify-between gap-1.5 text-[12px] font-medium ${
                    blocked ? 'text-text-3' : 'text-text-2'
                  }`}
                >
                  <span className="min-w-0 leading-tight">{stage.label}</span>
                  {/* One tooltip per card. Everything the card used to say in
                      extra lines is in here. `shrink-0` keeps it off the label:
                      "Application" fills the width and the ⓘ was sitting
                      against the final letter. */}
                  <InfoTip
                    label={`About ${stage.label}`}
                    align="start"
                    className="mt-[1px] shrink-0"
                  >
                    {detailFor(stage)}
                  </InfoTip>
                </p>

                <div className="flex min-h-[34px] items-start">
                  {blocked ? (
                    <NotMeasuredBadge />
                  ) : (
                    <p className="text-[24px] font-semibold leading-tight tabular text-text">
                      {formatCount(counts[stage.key] ?? 0)}
                    </p>
                  )}
                </div>

                <p className="mt-auto min-h-[30px] pt-1 text-[12px] leading-tight text-text-3">
                  {blocked ? 'nobody stamps this' : nounFor(stage)}
                </p>
              </div>

              {next && (
                /*
                  Sized by the chip, not the other way round. A fixed slot
                  (74px, then 54px) either let the words overflow onto the
                  cards or wrapped them a letter at a time, and how far they
                  got depended on the font's exact metrics — "not gat",
                  "retir", "38.2" in one browser and fine in another. The
                  label is one unbroken line with its ⓘ beneath, and the slot
                  takes that width, so the funnel row wraps sooner instead.
                */
                <div className="flex shrink-0 items-center justify-center px-1">
                  {ratio !== null ? (
                    /*
                      A real percentage between every pair of measured stages:
                      this period's count at the later stage over the earlier
                      one's. It replaced "not a gate" and "not nested" on 24
                      September 2026 — a client reads a withheld chip as a
                      broken funnel. The hover says in one sentence what the
                      two counts are, including when the later one is larger.
                    */
                    <span className="inline-flex flex-col items-center gap-0.5 rounded-[9px] border border-border bg-surface px-1 py-[3px] font-semibold tabular text-text whitespace-nowrap text-center text-[11px] leading-[1.15]">
                      {formatRate(ratio)}
                      <InfoTip label={`What ${formatRate(ratio)} means`} align="center">
                        {formatCount(counts[next!.key] ?? 0)} reached {next!.label} this period, against{' '}
                        {formatCount(counts[stage.key] ?? 0)} at {stage.label}
                        {ratio > 1
                          ? ' — more, because some deals reach a later stage without passing through the earlier one in the same period.'
                          : '.'}
                      </InfoTip>
                    </span>
                  ) : bridge ? (
                    <span className="inline-flex flex-col items-center gap-0.5 rounded-[9px] border border-dashed border-warn bg-warn-soft px-1 py-[3px] font-semibold tabular text-[#B54708] whitespace-nowrap text-center text-[11px] leading-[1.15]">
                      {bridge.rate.rate === null ? '—' : formatRate(bridge.rate.rate)}
                      <InfoTip label="What this rate spans" align="center">
                        {bridge.from.label} to {bridge.to.label},{' '}
                        {formatCount(bridge.rate.numerator)} of{' '}
                        {formatCount(bridge.rate.denominator)} — measured across{' '}
                        {bridge.skipped.join(', ')}, which{' '}
                        {bridge.skipped.length === 1 ? 'is' : 'are'} not measured.
                      </InfoTip>
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-center gap-0.5 rounded-[9px] border border-dashed border-border bg-canvas px-1 py-[3px] font-semibold text-text-3 whitespace-nowrap text-center text-[11px] leading-[1.15]">
                      no rate
                      <InfoTip label={`Why there is no rate into ${next.label}`} align="center">
                        Neither side of this transition is measured, and there is no measured stage
                        on both sides of the gap to bridge across, so nothing here can be stated as
                        a rate.
                      </InfoTip>
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* `sr-only` on a wrapper, not on the table: see `ChartTable`. */}
      <div className="sr-only">
        <table>
          <caption>Stage counts and conversion rates for {populationLabel}.</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Count</th>
              <th scope="col">Conversion from previous stage</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, i) => {
              const blocked = stageStatus[stage.key]?.blocked;
              const previous = stages[i - 1];
              const ratio =
                previous && measured[i] && measured[i - 1] && (counts[previous.key] ?? 0) > 0
                  ? (counts[stage.key] ?? 0) / (counts[previous.key] ?? 0)
                  : null;
              return (
                <tr key={stage.key}>
                  <td>{stage.label}</td>
                  <td>{blocked ? 'not measured' : formatCount(counts[stage.key] ?? 0)}</td>
                  <td>
                    {ratio === null ? 'not measurable' : formatRate(ratio)}
                  </td>
                  {/* The detail each card carries in its tooltip, so a screen
                      reader and the print sheet get it as text. */}
                  <td>{detailFor(stage)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
