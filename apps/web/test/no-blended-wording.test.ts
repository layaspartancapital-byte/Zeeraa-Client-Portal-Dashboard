import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "All sources", never "blended" (client decision, 30 October 2026). Reads
 * every source file and fails on the word anywhere — a label, an ⓘ, a method
 * note, a comment that would be copied into one.
 */
const root = join(__dirname, '../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });

describe('no "blended" on screen', () => {
  it('appears in no source file', () => {
    // The Zeeraa mark's comment is about image compositing, not a figure.
    const hits = files(root)
      .filter((f) => !f.endsWith('ZeeraaMark.tsx'))
      .filter((f) => /blended/i.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });
});
