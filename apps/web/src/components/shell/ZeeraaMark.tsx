import Image from 'next/image';

/**
 * The Zeeraa identity in the chrome.
 *
 * One asset, two presentations. `apps/web/public/zeeraa-logo.png` is the enso
 * and the wordmark on a black field, 196×67; the enso occupies the leftmost
 * ~28% of it. The collapsed rail is 64px and has no room for the wordmark, so
 * the mark-only form crops to the ring's own square (`RING`) rather than
 * shipping a second file that could drift from the first.
 *
 * The asset's field is `#000000` and the chrome is `#14161A`, which would show
 * as a slightly darker rectangle. The image is blended into the chrome rather
 * than laid on it — the artwork is pure gold on pure black, so `screen` drops
 * the black entirely and leaves the gold.
 *
 * **A modest brightness lift, for the same reason `--color-gold` is lifted.**
 * In the file the wordmark is a markedly darker bronze than the enso — about
 * `#A77F41` against the ring's brighter stroke — so on near-black the ring
 * reads as gold and the word reads as a smudge. The logo was drawn for print,
 * where those values are fine.
 *
 * The lift is deliberately small. Most of the legibility came from size rather
 * than brightness: the wordmark is a thin serif, and below about 30px its
 * strokes are sub-pixel and anti-alias to a dimmer grey whatever the filter
 * does. Pushing brightness far enough to match the ring blows the ring out.
 *
 * **This is the asset's limit, not the layout's.** An SVG would render the
 * strokes crisply at any size and let the two halves carry their own values;
 * with a raster there is one filter for both. Worth asking for one.
 */

const ASSET = { width: 196, height: 67 } as const;
/**
 * The enso's square in the asset, measured from the file: the ring's stroke
 * spans x and y 13–59, and this adds five pixels on every side. The mark used
 * to be the leading 28% of the width at the lockup's height, which cut the
 * ring's right edge and sat it high in the square (25 September 2026).
 */
const RING = { x: 8, y: 8, size: 57 } as const;

export function ZeeraaMark({
  /** Rendered height in pixels. The lockup keeps the asset's 2.93:1 ratio; the mark is square. */
  height = 26,
  variant = 'lockup',
}: {
  height?: number;
  variant?: 'lockup' | 'mark';
}) {
  const mark = variant === 'mark';
  const scale = mark ? height / RING.size : height / ASSET.height;
  const fullWidth = ASSET.width * scale;
  const fullHeight = ASSET.height * scale;
  const width = mark ? height : Math.round(fullWidth);

  return (
    <span
      className="relative block shrink-0 overflow-hidden"
      style={{ width, height }}
      /*
       * The accessible name lives here rather than on the image, so the
       * cropped form still announces the product rather than "logo".
       */
      role="img"
      aria-label="Zeeraa"
    >
      <Image
        src="/zeeraa-logo.png"
        alt=""
        width={ASSET.width}
        height={ASSET.height}
        priority
        className="absolute max-w-none mix-blend-screen"
        style={{
          width: fullWidth,
          height: fullHeight,
          left: mark ? -RING.x * scale : 0,
          top: mark ? -RING.y * scale : 0,
          filter: 'brightness(1.3) saturate(1.05)',
        }}
      />
    </span>
  );
}
