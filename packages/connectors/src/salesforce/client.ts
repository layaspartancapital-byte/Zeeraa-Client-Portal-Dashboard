import { requestAccessToken, type AccessToken, type JwtConfig } from './jwt';

/**
 * A small REST client. Deliberately small: phase 2 needs to ask an org
 * questions before anything is built on the answers, and a large client written
 * against assumed field names would be a liability.
 */
export class SalesforceClient {
  private token?: AccessToken;
  private apiVersion?: string;

  constructor(
    private readonly config: JwtConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async authenticate(): Promise<AccessToken> {
    this.token ??= await requestAccessToken(this.config, this.fetchImpl);
    return this.token;
  }

  /**
   * Asks the org which API versions it has rather than hardcoding one.
   * A hardcoded version silently ages out and starts refusing newer fields.
   */
  async version(): Promise<string> {
    if (this.apiVersion) return this.apiVersion;
    const { instanceUrl, accessToken } = await this.authenticate();
    const response = await this.fetchImpl(`${instanceUrl}/services/data`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const versions = (await response.json()) as { version: string }[];
    this.apiVersion = versions.at(-1)?.version ?? '62.0';
    return this.apiVersion;
  }

  private async call<T>(path: string): Promise<T> {
    const { instanceUrl, accessToken } = await this.authenticate();
    const response = await this.fetchImpl(`${instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SalesforceApiError(response.status, path, body.slice(0, 500));
    }
    return (await response.json()) as T;
  }

  async describe(sobject: string): Promise<DescribeResult> {
    return this.call<DescribeResult>(`/services/data/v${await this.version()}/sobjects/${sobject}/describe`);
  }

  /**
   * `queryAll` rather than `query`: it includes soft-deleted and archived rows,
   * which is the only way to see a record that was merged away.
   */
  async query<T>(soql: string, includeDeleted = false): Promise<T[]> {
    const endpoint = includeDeleted ? 'queryAll' : 'query';
    let path = `/services/data/v${await this.version()}/${endpoint}?q=${encodeURIComponent(soql)}`;
    const records: T[] = [];
    for (;;) {
      const page = await this.call<{ records: T[]; done: boolean; nextRecordsUrl?: string }>(path);
      records.push(...page.records);
      if (page.done || !page.nextRecordsUrl) break;
      path = page.nextRecordsUrl;
    }
    return records;
  }

  /**
   * A read-only Tooling API query.
   *
   * Lead-to-Opportunity field mappings are not in the data API — they are
   * metadata — and `ObjectMapping` / `ObjectMappingField` in the Tooling API are
   * the only way to read them without the Metadata API. A GET, so it cannot
   * write anything to the org whatever it is handed.
   */
  async toolingQuery<T>(soql: string): Promise<T[]> {
    const v = await this.version();
    let path = `/services/data/v${v}/tooling/query?q=${encodeURIComponent(soql)}`;
    const records: T[] = [];
    for (;;) {
      const page = await this.call<{ records: T[]; done: boolean; nextRecordsUrl?: string }>(path);
      records.push(...page.records);
      if (page.done || !page.nextRecordsUrl) break;
      path = page.nextRecordsUrl;
    }
    return records;
  }

  /**
   * Records hard-deleted in a window.
   *
   * `SystemModstamp` cannot see a deletion — the row is simply gone, and an
   * incremental pull keeps the stale copy forever. This endpoint is the only
   * way to learn about them, and it only reaches back about 30 days, which
   * bounds how long a sync may be broken before deletions are lost for good.
   */
  async getDeleted(sobject: string, start: Date, end: Date): Promise<DeletedResult> {
    const v = await this.version();
    const qs = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
    return this.call<DeletedResult>(`/services/data/v${v}/sobjects/${sobject}/deleted/?${qs}`);
  }

  async getUpdated(sobject: string, start: Date, end: Date): Promise<UpdatedResult> {
    const v = await this.version();
    const qs = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
    return this.call<UpdatedResult>(`/services/data/v${v}/sobjects/${sobject}/updated/?${qs}`);
  }
}

export class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Salesforce API ${status} on ${path}: ${body}`);
    this.name = 'SalesforceApiError';
  }
}

export type DescribeField = {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  length?: number;
  /** Bytes, not characters. Differs from `length` on multi-byte text fields. */
  byteLength?: number;
  precision?: number;
  scale?: number;
  nillable?: boolean;
  /**
   * Field-level security, as the *calling* user sees it.
   *
   * A describe reflects the running user's permissions, so a field hidden from
   * the integration user by FLS is absent here in exactly the way a field that
   * was never created is absent. `permissionable` says the field can have FLS
   * set on it at all, which distinguishes "somebody could have hidden this"
   * from a system field nobody can.
   */
  createable?: boolean;
  updateable?: boolean;
  permissionable?: boolean;
};

export type DescribeResult = {
  name: string;
  fields: DescribeField[];
};

export type DeletedResult = {
  deletedRecords: { id: string; deletedDate: string }[];
  earliestDateAvailable: string;
  latestDateCovered: string;
};

export type UpdatedResult = { ids: string[]; latestDateCovered: string };
