import { formatDuration } from '@zeeraa/core';
import { InfoTip } from '@/components/ui/InfoTip';
import type { SourceFreshness as Source } from '@/lib/dashboard';

/**
 * How current each source is, as one line under the title.
 *
 * Syncing is hourly, so "today" on this screen means "as of the last run" and
 * the difference is a real one: a client looking at a Tuesday morning figure is
 * looking at Monday plus however much of Tuesday the last run reached. Left
 * unsaid, a flat afternoon reads as a flat afternoon rather than as an hour
 * nobody has pulled yet.
 *
 * It is a strip rather than a card because it is a property of every figure on
 * the screen, not a figure of its own — putting it in a card would give it a
 * place in the reading order it has not earned, and putting it in each card's ⓘ
 * would repeat one timestamp eight times where it is invisible until hovered.
 *
 * **Calls are the exception and say so.** They arrive by webhook, so there is
 * no run to be behind and no staleness to report; what the row states is the
 * newest call received, and it is never amber. A quiet hour on the phones is a
 * quiet hour, and colouring it as a fault would make the desk's Sunday look
 * like a broken connector.
 */
export function SourceFreshness({
  sources,
  now,
  timezone,
  /** True where the range runs up to today, which is when staleness bites. */
  includesToday,
}: {
  sources: Source[];
  now: Date;
  timezone: string;
  includesToday: boolean;
}) {
  if (sources.length === 0) return null;

  const synced = sources.filter((s) => s.arrival === 'sync' && s.at);
  // The figures on this screen are only as current as the source that lags
  // most. Stating the oldest is the honest headline; stating an average would
  // be a number nothing is as of.
  const oldest = synced.sort((a, b) => a.at!.getTime() - b.at!.getTime())[0] ?? null;

  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-3">
      <span className="font-medium text-text-2">Sources</span>
      {sources.map((source) => (
        <SourceChip key={source.platform} source={source} now={now} timezone={timezone} />
      ))}

      {includesToday && oldest && (
        <span className="tabular">
          · today is as of {timeIn(oldest.at!, timezone)}
        </span>
      )}

      <InfoTip label="How current these figures are" align="end">
        Paid media and the CRM are pulled hourly, so a figure covering today
        reaches only as far as the last run. Calls are pushed by webhook as each
        one ends, so that row is the newest call received rather than a sync age.
      </InfoTip>
    </p>
  );
}

function SourceChip({
  source,
  now,
  timezone,
}: {
  source: Source;
  now: Date;
  timezone: string;
}) {
  const webhook = source.arrival === 'webhook';
  const age = source.at === null ? null : (now.getTime() - source.at.getTime()) / 1000;

  /*
   * Amber past two hours, and only for a synced source.
   *
   * Two hours is two missed runs on an hourly schedule: one is a retry, two is
   * a connector nobody is pulling from. A webhook source is never amber here,
   * however old its newest record — the age of the last call measures the
   * phones, and this strip is not the place to make a claim about them.
   */
  const stale = !webhook && (source.failing || age === null || age > 2 * 3600);

  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap ${
        stale ? 'font-medium text-[#B54708]' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-[#DC6803]' : 'bg-[#12B76A]'}`}
      />
      {source.label}
      <span className="tabular">
        {source.at === null
          ? webhook
            ? 'nothing received'
            : 'never synced'
          : webhook
            ? `last call ${formatDuration(age!)} ago`
            : `${formatDuration(age!)} ago`}
      </span>
      {source.failing && <span>· last run failed</span>}
      <span className="sr-only">
        {webhook
          ? `${source.label} arrives by webhook rather than on a schedule.`
          : source.at === null
            ? `${source.label} has never completed a sync.`
            : `${source.label} last synced at ${full(source.at, timezone)}.`}
      </span>
    </span>
  );
}

/** `14:02`, in the tenant's timezone — the zone every date on these screens is in. */
function timeIn(at: Date, timezone: string): string {
  return at.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function full(at: Date, timezone: string): string {
  return at.toLocaleString('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
