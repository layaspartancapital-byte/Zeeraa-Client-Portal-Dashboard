import type { Delta } from '@zeeraa/core';

/**
 * Assessment to colour.
 *
 * Its own module so it can be unit-tested: `Delta.tsx` is JSX, and this app's
 * vitest has no JSX transform — the same reason `platform-types.ts` sits apart
 * from the component that renders it. The join it asserts is the one that
 * matters on screen, because `delta()` and `improvementDirectionFor()` are both
 * correct in isolation and neither knows what colour anything ends up.
 *
 * The text variants, not the fill tokens: the spec's green is 2.6:1 on white
 * and will not carry type. `level` covers both "unchanged" and "this metric
 * declares no direction", and both render in `--text-2` — the delta still shows
 * its sign and its arrow, it simply makes no claim about whether that is good.
 */
export function toneFor(assessment: Delta['assessment']): string {
  if (assessment === 'ahead') return 'text-up-text';
  if (assessment === 'shortfall') return 'text-down-text';
  return 'text-text-2';
}
