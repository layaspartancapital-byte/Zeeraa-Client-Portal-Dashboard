/**
 * Sets, or clears, one tenant's logo.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-tenant-logo.ts spartan path/to/logo.svg --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-tenant-logo.ts spartan path/to/logo.svg
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-tenant-logo.ts spartan --clear
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/set-tenant-logo.ts spartan mark.png --mark --dry-run
 *
 * `--mark` writes the square mark the collapsed rail shows (migration 0038)
 * instead of the logo; `--mark --clear` returns it to the monogram.
 *
 * The logo lives on the tenant row as a `data:` URL (migration 0025), so it is
 * read under the `tenants` policy and never has a public URL. This is the only
 * writer: the application has no path that sets it.
 *
 * The type is decided by the file's bytes, not its name — a `.png` that is
 * really an HTML page is refused. `--dry-run` writes and rolls back after the
 * read-back, because `tenants` is FORCE RLS'd and a denied write exits 0.
 */
import { readFileSync, statSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY_RUN = process.argv.includes('--dry-run');
const CLEAR = process.argv.includes('--clear');
const MARK = process.argv.includes('--mark');
const column = MARK ? schema.tenants.markDataUrl : schema.tenants.logoDataUrl;
const [slug, file] = args;

if (!slug || (!file && !CLEAR)) {
  console.error('Usage: set-tenant-logo.ts <slug> <file> [--dry-run] | <slug> --clear');
  process.exit(2);
}

/** The column's own limit in data URL (256 KB, or 64 KB for a mark), as image bytes. */
const MAX_BYTES = MARK ? 48_000 : 190_000;

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

let dataUrl: string | null = null;
if (!CLEAR) {
  const size = statSync(file!).size;
  if (size > MAX_BYTES) {
    console.error(`Refusing: ${file} is ${size} bytes; the limit is ${MAX_BYTES}. Export it smaller.`);
    process.exit(2);
  }
  const bytes = readFileSync(file!);
  const type = sniff(bytes);
  if (!type) {
    console.error(`Refusing: ${file} is not a PNG, JPEG, WebP or SVG by its contents.`);
    process.exit(2);
  }
  if (type === 'image/svg+xml' && /<script|\son\w+\s*=|javascript:/i.test(bytes.toString('utf8'))) {
    // Inert inside <img>, but a logo has no business carrying script at all.
    console.error('Refusing: the SVG carries script or event handlers. Export it clean.');
    process.exit(2);
  }
  dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
}

class Rollback extends Error {}
const { db, close } = getOwnerDb();

try {
  await withMaintenance(db, async (tx) => {
    const updated = await tx
      .update(schema.tenants)
      .set(MARK ? { markDataUrl: dataUrl } : { logoDataUrl: dataUrl })
      .where(eq(schema.tenants.slug, slug))
      .returning({ id: schema.tenants.id, name: schema.tenants.name });
    if (updated.length !== 1) {
      throw new Error(
        `Expected to update one tenant "${slug}", updated ${updated.length}. Zero is what a ` +
          'write denied by row level security looks like, as well as an unknown slug.',
      );
    }
    const [row] = await tx
      .select({ length: sql<number>`coalesce(length(${column}), 0)::int` })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    console.log(
      `${DRY_RUN ? 'Dry run' : 'Set'} ${MARK ? 'mark' : 'logo'}: ${updated[0]!.name} — ${
        dataUrl ? `${dataUrl.slice(5, dataUrl.indexOf(';'))}, ${row!.length} characters` : MARK ? 'cleared, monogram shown' : 'cleared, initials shown'
      }`,
    );
    if (DRY_RUN) throw new Rollback();
  }).catch((error) => {
    if (error instanceof Rollback) return console.log('Rolled back. Nothing changed.');
    throw error;
  });
} finally {
  await close();
}
