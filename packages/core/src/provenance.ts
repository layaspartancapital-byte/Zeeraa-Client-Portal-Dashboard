/**
 * Provenance (§12).
 *
 * A number with no resolvable source never renders — the caller must render an
 * explicit empty state instead. `Sourced<T>` makes that unavoidable at the type
 * level: there is no way to hand a figure to the UI without saying where it
 * came from.
 */

export type Provenance =
  | {
      kind: 'api';
      /** Connector key, e.g. 'google_ads'. Drives the hairline platform mark. */
      platform: string;
      /** Completion time of the sync this figure came from. */
      syncedAt: Date;
      syncRunId?: string;
    }
  | {
      kind: 'manual';
      recordedByUserId: string;
      recordedByName: string;
      recordedAt: Date;
    };

export type Sourced<T> = {
  value: T;
  source: Provenance;
  /**
   * True when the underlying window is still settling — the trailing 7 days of
   * any spend or conversion series. Rendered in --provisional, "still settling".
   */
  provisional?: boolean;
};

export function sourced<T>(value: T, source: Provenance, provisional = false): Sourced<T> {
  return { value, source, provisional };
}

/** Trailing-7-day rule from §12. `today` is the tenant's local date. */
export function isProvisional(date: Date, today: Date, days = 7): boolean {
  const ms = today.getTime() - date.getTime();
  return ms < days * 24 * 60 * 60 * 1000;
}

export function provenanceLabel(source: Provenance): string {
  switch (source.kind) {
    case 'api':
      return `Synced from ${source.platform}`;
    case 'manual':
      return `Recorded by ${source.recordedByName}`;
  }
}
