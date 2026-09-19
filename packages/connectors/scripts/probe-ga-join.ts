/**
 * Read-only: could a GA4 session ever be joined to a Salesforce lead?
 *
 *   pnpm --filter @zeeraa/connectors probe-ga-join
 *
 * This is the question that decides whether GA4 belongs in the attribution
 * join or only in an organic section of its own, and it has to be answered
 * before anything is wired into the funnel rather than after.
 *
 * **The GA4 Data API exposes no identifier for a person or a session.** There
 * is no `clientId` dimension and no `sessionId` dimension; session identity
 * lives in the BigQuery export (`user_pseudo_id`, `ga_session_id`) or in a
 * custom dimension the site registers and populates itself. So a join can only
 * exist if the *website* wrote an identifier onto the form that GA4 also sees.
 *
 * This script looks for that identifier on Lead and reports its shape, because
 * shape is what settles it: GA4's `ga_session_id` is a Unix timestamp in
 * digits and its client id is `<digits>.<digits>`. A UUID is neither, and a
 * field full of UUIDs is the form vendor's own session handle — useless for a
 * GA4 join however well populated it is.
 */
import { SalesforceClient } from '../src/salesforce/client';

const required = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_PRIVATE_KEY_BASE64', 'SF_LOGIN_URL'] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Cannot probe: ${missing.join(', ')} not set.`);
  process.exit(2);
}

const client = new SalesforceClient({
  clientId: process.env.SF_CLIENT_ID!,
  username: process.env.SF_USERNAME!,
  privateKeyBase64: process.env.SF_PRIVATE_KEY_BASE64!,
  loginUrl: process.env.SF_LOGIN_URL!,
});

/** Anything that could plausibly carry a GA identifier or a session handle. */
const PATTERNS = [
  /client.?id/i, /\bcid\b/i, /_ga/i, /ga_?session/i, /session.?id/i,
  /analytics/i, /measurement/i, /user.?id/i, /visitor/i, /\bga4\b/i,
];

const describe = await client.describe('Lead');
const candidates = describe.fields.filter((f) => PATTERNS.some((p) => p.test(f.name)));

console.log(`Lead has ${describe.fields.length} fields. Candidates for a GA join:\n`);
if (candidates.length === 0) console.log('  (none)');
for (const f of candidates) {
  console.log(`  ${f.name}  (${f.type}${f.length ? `, ${f.length}` : ''})`);
}

/**
 * What a value actually looks like. GA4's own identifiers are digit-shaped; a
 * UUID is somebody else's.
 */
function classify(value: string): string {
  if (/^\d{9,13}$/.test(value)) return 'digits — could be a GA4 ga_session_id';
  if (/^\d+\.\d+$/.test(value)) return 'digits.digits — could be a GA4 client id';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return 'UUID — NOT a GA4 identifier';
  }
  return 'unrecognised shape';
}

for (const field of candidates) {
  const rows = await client.query<Record<string, string>>(
    `SELECT ${field.name} FROM Lead WHERE ${field.name} != null ` +
      'AND CreatedDate >= LAST_N_DAYS:90 ORDER BY CreatedDate DESC LIMIT 20',
  );
  const values = rows.map((r) => String(r[field.name] ?? '')).filter(Boolean);
  if (values.length === 0) continue;
  const kinds = new Set(values.map(classify));
  console.log(`\n${field.name}: ${values.length} sampled`);
  for (const kind of kinds) console.log(`  ${kind}`);
  console.log(`  example length ${values[0]!.length}`);
}

// Coverage against the only population GA4 could ever match: leads that came
// from the web at all. Measured against every lead it would look like nothing,
// because most leads in this org are cold outreach and never saw the site.
const web =
  'CreatedDate >= LAST_N_DAYS:90 AND (utm_source__c != null OR gclid__c != null ' +
  'OR acq_fbclid__c != null OR pi__url__c != null)';
const [all] = await client.query<{ n: number }>(`SELECT COUNT(Id) n FROM Lead WHERE ${web}`);
console.log(`\nweb-originated leads, last 90 days: ${all!.n}`);
for (const field of candidates) {
  const [n] = await client.query<{ n: number }>(
    `SELECT COUNT(Id) n FROM Lead WHERE ${web} AND ${field.name} != null`,
  );
  const pct = all!.n ? ((n!.n / all!.n) * 100).toFixed(1) : '0.0';
  console.log(`  carrying ${field.name.padEnd(24)} ${String(n!.n).padStart(5)} (${pct}%)`);
}
