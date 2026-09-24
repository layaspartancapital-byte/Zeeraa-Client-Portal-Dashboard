import { InfoTip } from '@/components/ui/InfoTip';
import { Segmented, type Segment } from '@/components/ui/Segmented';

/**
 * The Last touch / First touch toggle, with what the choice means beside it.
 *
 * One component so the two screens that carry the toggle cannot explain it
 * differently. The example is the whole explanation: which click gets the
 * credit is easier to see in one deal than to define.
 */
export const ATTRIBUTION_MODEL_EXPLANATION =
  'Clicked a Meta ad Monday, a Google ad Friday, then applied. Last touch credits Google; first touch credits Meta.';

export function AttributionModelToggle({ active, options }: { active: string; options: Segment[] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Segmented label="Attribution model" active={active} options={options} />
      <InfoTip label="What last touch and first touch mean" align="end">
        {ATTRIBUTION_MODEL_EXPLANATION}
      </InfoTip>
    </span>
  );
}
