import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vercel Cron is the only scheduler.
 *
 * Inngest was removed from the code on 18 September 2026 but not from Inngest
 * Cloud: its hourly cron kept calling `/api/inngest` on a deployment from
 * before the removal — Vercel keeps every deployment live at its own URL, with
 * that deployment's code and database credentials — and ran five days of
 * Salesforce syncs on the old code against production. Nothing in this
 * repository could see it. These keep the code side from re-growing a second
 * scheduler; the Cloud side is in `docs/state.md`.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('the scheduler', () => {
  it('has no Inngest route, client or dependency', () => {
    expect(existsSync(join(ROOT, 'apps/web/src/app/api/inngest'))).toBe(false);
    expect(existsSync(join(ROOT, 'packages/jobs/src/inngest'))).toBe(false);
    for (const pkg of ['package.json', 'apps/web/package.json', 'packages/jobs/package.json']) {
      expect(readFileSync(join(ROOT, pkg), 'utf8')).not.toMatch(/"inngest"/);
    }
    expect(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')).not.toMatch(/\binngest@/);
  });

  it('has no second schedule for a host to install', () => {
    expect(existsSync(join(ROOT, 'scripts-crontab.example'))).toBe(false);
  });
});
