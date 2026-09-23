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
  suppressed = [],
  maxLeakage,
  gateFor,
}: {
  /**
   * The population verdict for a conversion rate over this denominator, from
   * `metrics.population('stage_conversion_rate', n)`. A rate below its floor
   * is withheld with the reason, like a rate that is not a conversion rate.
   */
  gateFor?: (denominator: number) => PopulationVerdict;
  data: MonthlyPerformance;
  counts: StageCounts;
  populationLabel: string;
  /**
   * Transitions that must carry no rate, each with the reason.
   *
   * Comes from a blocked metric whose formula is a stage conversion rate, so
   * one row retires a figure everywhere it appears rather than on the screen
   * somebody remembered.
   */
  suppressed?: { from: string; to: string; label: string; reason: string }[];
  /**
   * The share of a later stage that may have skipped the earlier one before
   * the ratio stops being a conversion rate. From configuration.
   */
  maxLeakage: number;
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

  /**
   * Why a transition is not a conversion rate, or null when it is one.
   *
   * A conversion rate presumes the later population is drawn from the earlier
   * one. Two separate things can break that, and only one of them shows up in
   * the arithmetic: the ratio exceeding 100%, which is the arithmetic reporting
   * that the denominator is the wrong population; and the populations being
   * declared not to nest, which stays invisible when the numerator happens to
   * be the smaller number.
   *
   * The second is the case here. MQL is computed from self-reported fields
   * after the fact rather than being a gate a lead passes through, so an
   * unqualified lead can and does still apply: 441 applications against 649
   * qualified leads is 68% of a population the applications were never drawn
   * from. Before MQL was counted at lead grain the same transition read 1,696%
   * and the numeric guard caught it; at the right grain it looks plausible,
   * which is exactly why the rule cannot be left to arithmetic.
   */
  const notARate = (
    from: { key: string; source?: string },
    to: { key: string; source?: string },
    rate: { numerator: number; denominator: number },
  ): 'suppressed' | 'not-drawn-from' | 'not-nested' | 'over-total' | 'too-few' | null => {
    if (suppressed.some((t) => t.from === from.key && t.to === to.key)) return 'suppressed';
    if (from.source === 'qualified_leads' && to.source !== 'qualified_leads') {
      return 'not-drawn-from';
    }
    const step = progression[to.key];
    if (step && step.previous === from.key && step.reached > 0) {
      const leaked = (step.reached - step.alsoPrevious) / step.reached;
      if (leaked > maxLeakage) return 'not-nested';
    }
    if (rate.denominator !== 0 && rate.numerator > rate.denominator) return 'over-total';
    if (gateFor && rate.denominator > 0 && !gateFor(rate.denominator).sufficient) return 'too-few';
    return null;
  };

  /** The two words the chip shows when a ratio is not a conversion rate. */
  const WITHHELD_LABEL = {
    suppressed: 'retired',
    'not-drawn-from': 'not a gate',
    'not-nested': 'not nested',
    'over-total': 'over 100%',
    'too-few': 'too few',
  } as const;

  return (
    <div className="px-5 pb-5">
      <div className="flex flex-wrap items-stretch gap-y-4">
        {stages.map((stage, i) => {
          const blocked = stageStatus[stage.key]?.blocked;
          const next = stages[i + 1];
          const bothMeasured = next ? measured[i] && measured[i + 1] : false;
          const adjacent =
            next && bothMeasured ? stageConversionRate(reach, stage.key, next.key) : null;
          const bridge = next && !bothMeasured ? bridgeFor(i) : null;
          const crossesGrain = next ? grainOf(stage.source) !== grainOf(next.source) : false;
          const withheld = next && adjacent ? notARate(stage, next, adjacent) : null;
          const step = next ? progression[next.key] : undefined;
          const leaked =
            step && next && step.previous === stage.key ? step.reached - step.alsoPrevious : 0;

          return (
            <div key={stage.key} className="flex min-w-0 flex-1 basis-[112px] items-stretch">
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
                  Sized so the chip fits *inside* it. At 74px the words
                  overflowed both edges and sat on top of the cards, which
                  truncated them — a chip that says "not neste" is worse than
                  the em dash it replaced.
                */
                <div className="flex w-[54px] shrink-0 items-center justify-center px-0.5">
                  {adjacent && withheld ? (
                    /*
                      A withheld rate says so in words. The em dash this used to
                      render reads as missing data, and four of six transitions
                      here are withheld on purpose — the populations do not
                      nest, or the earlier stage is not a gate the later one
                      passes through.
                    */
                    <span className="inline-flex flex-wrap items-center gap-x-1 rounded-[9px] border border-dashed border-border bg-canvas px-1 py-[3px] font-semibold text-text-3 w-full justify-center whitespace-normal break-words text-center text-[11px] leading-[1.15]">
                      {WITHHELD_LABEL[withheld]}
                      <InfoTip label={`Why there is no rate into ${next.label}`} align="center">
                        {withheld === 'suppressed'
                          ? suppressed.find((t) => t.from === stage.key && t.to === next.key)
                              ?.reason
                          : withheld === 'not-nested'
                            ? `${formatCount(
                                (progression[next.key]?.reached ?? 0) -
                                  (progression[next.key]?.alsoPrevious ?? 0),
                              )} of the ${formatCount(
                                progression[next.key]?.reached ?? 0,
                              )} deals reaching ${next.label} never reached ${stage.label} at all. The later population is not drawn from the earlier one, so their ratio is not a conversion rate however plausible it looks.`
                            : withheld === 'not-drawn-from'
                              ? `${stage.label} is computed from what a lead reported, not a gate it passes through — a lead that misses the bar can still reach ${next.label}. So ${next.label} is not drawn from ${stage.label}, and the ratio is not a conversion rate even though it lands under 100%.`
                              : withheld === 'too-few'
                                ? gateFor!(adjacent.denominator).reason
                                : `${formatCount(adjacent.numerator)} reached ${next.label} against ${formatCount(adjacent.denominator)} at ${stage.label}. A ratio above 100% is the arithmetic reporting that these are not nested populations.`}
                      </InfoTip>
                    </span>
                  ) : adjacent ? (
                    <span className="inline-flex flex-wrap items-center gap-x-1 rounded-[9px] border border-border bg-surface px-1 py-[3px] font-semibold tabular text-text w-full justify-center whitespace-normal break-words text-center text-[11px] leading-[1.15]">
                      {adjacent.rate === null ? '—' : formatRate(adjacent.rate)}
                      {/* The rate's own caveats share the chip's single ⓘ
                          rather than adding a second one beside it. */}
                      {(crossesGrain || leaked > 0) && (
                        <InfoTip label={`About the rate into ${next.label}`} align="center">
                          {crossesGrain
                            ? 'This rate divides opportunities by inbound leads. It is a different kind of statement from a rate inside one grain, and the two are not comparable.'
                            : `${formatCount(leaked)} of the ${formatCount(
                                progression[next.key]!.reached,
                              )} deals reaching ${next.label} have no ${stage.label} event, so the numerator holds ${
                                leaked === 1 ? 'one deal' : `${formatCount(leaked)} deals`
                              } the denominator does not. Below the configured tolerance, so the rate is shown rather than withheld.`}
                        </InfoTip>
                      )}
                    </span>
                  ) : bridge ? (
                    <span className="inline-flex flex-wrap items-center gap-x-1 rounded-[9px] border border-dashed border-warn bg-warn-soft px-1 py-[3px] font-semibold tabular text-[#B54708] w-full justify-center whitespace-normal break-words text-center text-[11px] leading-[1.15]">
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
                    <span className="inline-flex flex-wrap items-center gap-x-1 rounded-[9px] border border-dashed border-border bg-canvas px-1 py-[3px] font-semibold text-text-3 w-full justify-center whitespace-normal break-words text-center text-[11px] leading-[1.15]">
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
              const rate =
                previous && measured[i] && measured[i - 1]
                  ? stageConversionRate(reach, previous.key, stage.key)
                  : null;
              const withheld =
                previous && rate ? notARate(previous, stage, rate) : null;
              return (
                <tr key={stage.key}>
                  <td>{stage.label}</td>
                  <td>{blocked ? 'not measured' : formatCount(counts[stage.key] ?? 0)}</td>
                  <td>
                    {!rate
                      ? 'not measurable'
                      : withheld
                        ? `no rate — ${WITHHELD_LABEL[withheld]}`
                        : rate.rate === null
                          ? 'not measurable'
                          : formatRate(rate.rate)}
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
