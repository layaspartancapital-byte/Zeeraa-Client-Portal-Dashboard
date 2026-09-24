import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBusinessHours, salesforceSyncDue, withinBusinessHours } from '@zeeraa/core';
// Read from the seed by path: the package does not export its seeds.
import { spartan } from '../../../packages/db/seeds/spartan';

/**
 * The Salesforce crons against the desk hours they are sized for.
 *
 * Vercel Cron is UTC and has no timezone, so the ten-minute envelope
 * (`*\/10 13-22 * * 1-5`) is a fixed UTC window that has to hold 9–6 Eastern in
 * EDT and in EST. Walked minute by ten minutes over a whole year, so both clock
 * changes are crossed: every minute the desk is open must have a tick, and every
 * UTC hour must have a tick in its first ten minutes — the hourly floor that
 * `salesforceSyncDue` reads every tenant on.
 */
const config = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'vercel.json'), 'utf8')) as {
  crons: { path: string; schedule: string }[];
};
const schedules = config.crons.filter((c) => c.path === '/api/cron/salesforce').map((c) => c.schedule);

function field(spec: string, value: number): boolean {
  return spec.split(',').some((part) => {
    const [range, step] = part.split('/') as [string, string | undefined];
    const [lo, hi] = range === '*' ? [0, 59] : range.includes('-') ? range.split('-').map(Number) : [Number(range), step ? 59 : Number(range)];
    return value >= lo! && value <= hi! && (value - lo!) % Number(step ?? 1) === 0;
  });
}

function fires(schedule: string, at: Date): boolean {
  const [min, hour, dom, month, dow] = schedule.split(' ') as [string, string, string, string, string];
  return (
    field(min, at.getUTCMinutes()) &&
    field(hour, at.getUTCHours()) &&
    field(dom, at.getUTCDate()) &&
    field(month, at.getUTCMonth() + 1) &&
    field(dow, at.getUTCDay())
  );
}

const ticks = (at: Date) => schedules.filter((s) => fires(s, at)).length;

const row = spartan.config.find((c: { key: string }) => c.key === 'lead_response_hours');
const hours = parseBusinessHours(row?.value)!;

describe('the Salesforce cron schedule', () => {
  it('reads the seed desk hours', () => {
    expect(hours).not.toBeNull();
  });

  it('ticks every ten minutes the desk is open, across both clock changes', () => {
    const missed: string[] = [];
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 10 * 60_000) {
      const at = new Date(t);
      if (withinBusinessHours(at, hours) && ticks(at) === 0) missed.push(at.toISOString());
    }
    expect(missed).toEqual([]);
  });

  it('ticks exactly once at the top of every UTC hour, and never twice at any minute', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2026, 0, 15); t += 10 * 60_000) {
      const at = new Date(t);
      expect(ticks(at), at.toISOString()).toBeLessThanOrEqual(1);
      if (at.getUTCMinutes() === 0) expect(ticks(at), at.toISOString()).toBe(1);
    }
  });

  it('syncs nobody on a closed-desk tick past the hour', () => {
    // Saturday 26 September 2026, 15:20 UTC: no cron fires, and if one did
    // the route would read no tenant.
    const at = new Date('2026-09-26T15:20:00Z');
    expect(ticks(at)).toBe(0);
    expect(salesforceSyncDue(at, hours)).toBe(false);
  });
});
