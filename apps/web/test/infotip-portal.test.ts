import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The ⓘ bubble is never clipped by a scrolling ancestor.
 *
 * A table that scrolls inside its card (`overflow-x-auto`, the rule for
 * anything wide at 375px) clips an absolutely positioned descendant, which is
 * how the "Offer amount" header's bubble came to be cut off (13 October 2026).
 * So the bubble renders in a portal on `document.body`, fixed against the
 * icon. Read from the source, because every ⓘ on every screen is this one
 * component.
 */
const source = readFileSync(join(__dirname, '../src/components/ui/InfoTip.tsx'), 'utf8');

describe('InfoTip', () => {
  it('renders its bubble through a portal on document.body', () => {
    expect(source).toMatch(/createPortal\(/);
    expect(source).toMatch(/document\.body/);
  });

  it('positions the bubble fixed, and follows scrolls inside any container', () => {
    const bubble = /role="tooltip"[\s\S]*?className="([^"]+)"/.exec(source)?.[1] ?? '';
    expect(bubble.split(/\s+/)).toContain('fixed');
    expect(bubble.split(/\s+/)).not.toContain('absolute');
    expect(source).toMatch(/addEventListener\('scroll', position, true\)/);
  });
});
