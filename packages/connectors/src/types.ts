import type { DateRange } from '@zeeraa/core';

export type Connection = {
  id: string;
  tenantId: string;
  platform: string;
  accountIdentifier: string;
  /** Decrypted at the call site; a connector never sees ciphertext. */
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Connectors normalise dates into this zone at ingest, never at query time. */
  tenantTimezone: string;
  tenantCurrency: string;
};

export type ConnectionHealth =
  | { state: 'healthy'; accountName?: string; detail?: string }
  | { state: 'degraded'; detail: string }
  | { state: 'failing'; detail: string }
  /**
   * The dependency sits outside Zeeraa's control — a Salesforce field that does
   * not exist yet, click-ID capture not live on the site. Surfaced as its own
   * state rather than as a failure (§9.5, §16).
   */
  | { state: 'waiting_on_client'; detail: string; since?: Date };

export type DailyMetricRow = {
  /** Tenant-local calendar day, `YYYY-MM-DD`. Already normalised. */
  date: string;
  externalCampaignId: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  /** As reported, fractions included. Rounding happens at render. */
  platformConversions: number;
};

export type CampaignRow = {
  externalCampaignId: string;
  name: string;
  status?: string;
  externalAccountId?: string;
};

/**
 * Every platform sits behind this interface so that adding one never touches
 * the application. The asymmetry between platforms — Meta's submit-then-poll
 * jobs, Microsoft's zipped CSV over SOAP, Google's GAQL quotas — is absorbed
 * inside each module, not leaked into the caller.
 */
export interface Connector {
  key: string;
  label: string;
  testConnection(conn: Connection): Promise<ConnectionHealth>;
  fetchDailyMetrics(conn: Connection, range: DateRange): Promise<DailyMetricRow[]>;
  fetchEntities?(conn: Connection): Promise<CampaignRow[]>;
  /**
   * One day of clicks, keyed by the platform's click id.
   *
   * Optional because not every platform exposes clicks at this grain, and
   * single-day because the two that do — Google's `click_view`, Microsoft's
   * click-performance report — both refuse a range. That is the shape of the
   * upstream constraint rather than a choice made here, so it is in the
   * interface: a caller cannot accidentally ask for a window.
   */
  fetchClicks?(conn: Connection, day: string): Promise<ClickRow[]>;
}

/**
 * A click the platform charged for.
 *
 * `reportedDate` is the *ad account's* calendar day. It is deliberately not
 * renamed to `date`: unlike a CRM record there is no instant underneath it to
 * re-bucket into the tenant's zone, so the caller has to know whose day it is.
 */
export type ClickRow = {
  clickId: string;
  reportedDate: string;
  externalCampaignId: string | null;
  externalAdGroupId: string | null;
  adNetworkType: string | null;
  device: string | null;
};
