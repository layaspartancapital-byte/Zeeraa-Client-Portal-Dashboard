import { timingSafeEqual } from 'node:crypto';

/**
 * The request half of the Aloware endpoint: who may post, and what a post
 * looked like when it was refused.
 *
 * Two senders post to one endpoint. The Zap sends `Authorization: Bearer
 * <secret>`; Aloware's own webhook offers None, Basic or Bearer and fills the
 * header itself. On 24 September its posts were refused as unauthenticated and
 * nothing recorded what they had actually sent, so the fix had to be a guess.
 * `describeRequest` is what makes the next refusal say why.
 */

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Length-guarded: timingSafeEqual throws on a mismatch rather than returning false.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Bearer abc`, `bearer  abc `, `Basic …` → scheme and credential. */
function split(header: string): { scheme: string; credential: string } | null {
  const match = /^\s*([A-Za-z]+)\s+(.+?)\s*$/.exec(header);
  return match ? { scheme: match[1]!.toLowerCase(), credential: match[2]! } : null;
}

function basicParts(credential: string): { user: string; password: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(credential, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Whether an `Authorization` header carries the secret.
 *
 * Bearer with the scheme in any case and surrounding whitespace, or Basic with
 * the secret as the password — or as the user name with an empty password,
 * which is how a form with one "token" box tends to fill Basic. Every branch
 * still requires the whole secret, compared in constant time; none widens who
 * can post, only how the same secret may be written.
 */
export function credentialMatches(header: string | null, secret: string | null): boolean {
  if (!secret || !header) return false;
  const parts = split(header);
  if (!parts) return false;
  if (parts.scheme === 'bearer') return same(parts.credential, secret);
  if (parts.scheme === 'basic') {
    const basic = basicParts(parts.credential);
    if (!basic) return false;
    // Both compared, so the timing does not say which half was right.
    const password = same(basic.password, secret);
    const user = same(basic.user, secret) && basic.password === '';
    return password || user;
  }
  return false;
}

/** What the `Authorization` header looked like, without what it said. */
export type AuthShape = {
  present: boolean;
  /** `bearer`, `basic`, `other`, or null when absent or unparseable. */
  scheme: string | null;
  credentialLength: number;
  /** Bearer: the credential is the secret once trimmed. */
  bearerMatches: boolean;
  /** Basic: the decoded password (or a lone user name) is the secret. */
  basicMatches: boolean;
  /** The secret appears anywhere in the header, e.g. a doubled `Bearer Bearer`. */
  containsSecret: boolean;
};

export type RequestFingerprint = {
  at: string;
  userAgent: string | null;
  contentType: string | null;
  /** Every header name, lower-cased and sorted. Names only. */
  headerNames: string[];
  /** Query parameter names, in case a token was put in the URL. Names only. */
  queryNames: string[];
  auth: AuthShape;
  /** Whether the body parsed as JSON. */
  json: boolean;
  /** Every key path in the body, `[]` for an array element. Names only. */
  fields: string[];
  /**
   * The few values that describe a post rather than a person: the event name,
   * the type, direction and status codes, and the *shape* of the timestamp
   * (digits as `n`), which is what says whether it carries an offset.
   */
  values: Record<string, string>;
};

const MAX_FIELDS = 300;
const MAX_DEPTH = 4;
const MAX_VALUE = 80;

/**
 * Fields whose values are safe to keep. Codes and vocabulary only: never a
 * number, a name, an email, a note or a recording URL.
 */
const SAFE_VALUES = [
  'event',
  'Event',
  'body.type',
  'body.direction',
  'body.current_status',
  'body.disposition_status',
  'Type',
  'Direction',
  'Current Status',
  'Disposition Status',
];
/** Timestamps: kept as their shape only. */
const TIMESTAMPS = ['body.created_at', 'Created At'];

function keyPaths(value: unknown, prefix: string, depth: number, out: Set<string>): void {
  if (out.size >= MAX_FIELDS || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    const path = `${prefix}[]`;
    if (value.length > 0) keyPaths(value[0], path, depth + 1, out);
    else out.add(path);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (out.size >= MAX_FIELDS) return;
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      keyPaths(child, path, depth + 1, out);
    }
  }
}

function at(value: unknown, path: string): unknown {
  let cursor = value;
  for (const part of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function clip(text: string): string {
  return text.length <= MAX_VALUE ? text : `${text.slice(0, MAX_VALUE - 1)}…`;
}

/**
 * A post, described without its content.
 *
 * Built for a refusal — the post that has to say what it sent so the
 * matching can be fixed — and for each sender's first accepted post of the
 * day, so a renamed field shows up as a changed list rather than a gap.
 */
export function describeRequest(input: {
  headers: Iterable<[string, string]>;
  url: string;
  body: unknown;
  json: boolean;
  secret: string | null;
  now?: Date;
}): RequestFingerprint {
  const headers = new Map<string, string>();
  for (const [name, value] of input.headers) headers.set(name.toLowerCase(), value);

  const authorization = headers.get('authorization') ?? null;
  const parts = authorization ? split(authorization) : null;
  const secret = input.secret ?? '';
  let basicMatches = false;
  if (parts?.scheme === 'basic' && secret) {
    const basic = basicParts(parts.credential);
    basicMatches = !!basic && (basic.password === secret || (basic.user === secret && basic.password === ''));
  }

  let queryNames: string[] = [];
  try {
    queryNames = [...new Set(new URL(input.url).searchParams.keys())].sort();
  } catch {
    queryNames = [];
  }

  const fields = new Set<string>();
  if (input.json) keyPaths(input.body, '', 0, fields);

  const values: Record<string, string> = {};
  if (input.json && input.body && typeof input.body === 'object') {
    for (const path of SAFE_VALUES) {
      const value = at(input.body, path);
      if (value !== undefined && value !== null && typeof value !== 'object') {
        values[path] = clip(String(value));
      }
    }
    for (const path of TIMESTAMPS) {
      const value = at(input.body, path);
      if (typeof value === 'string' || typeof value === 'number') {
        values[`${path} (shape)`] = clip(String(value).replace(/\d/g, 'n'));
      }
    }
  }

  return {
    at: (input.now ?? new Date()).toISOString(),
    userAgent: headers.has('user-agent') ? clip(headers.get('user-agent')!) : null,
    contentType: headers.has('content-type') ? clip(headers.get('content-type')!) : null,
    headerNames: [...headers.keys()].sort(),
    queryNames,
    auth: {
      present: authorization !== null,
      scheme: parts ? (['bearer', 'basic'].includes(parts.scheme) ? parts.scheme : 'other') : null,
      credentialLength: parts ? parts.credential.length : 0,
      bearerMatches: parts?.scheme === 'bearer' && !!secret && parts.credential === secret,
      basicMatches,
      containsSecret: !!secret && !!authorization && authorization.includes(secret),
    },
    json: input.json,
    fields: [...fields].sort(),
    values,
  };
}
