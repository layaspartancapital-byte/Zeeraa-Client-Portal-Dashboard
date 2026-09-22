/**
 * Finds the field holding an answer by **what its values look like**, not by
 * what it is called.
 *
 * The name-based sweep that built the qualification mapping missed the
 * best-covered duration answer in Spartan's org, because it matched fields
 * whose name or label describes the concept — `time in business`, `years in
 * business` — and the field is called
 * `How_long_have_you_been_in_business__c`, after the question a merchant was
 * asked. No concept-shaped pattern reaches a field named after a sentence. This
 * sweep does, and it is the one to run first.
 *
 *   SF_CLIENT_ID=… SF_USERNAME=… SF_PRIVATE_KEY_BASE64=… SF_LOGIN_URL=… \
 *   LEAD_EXCLUSION='{…}' \
 *   MATCH='less than \$?10,?000|\$?10,?000 ?- ?\$?20,?000' \
 *   SINCE=2026-06-01 \
 *   pnpm --filter @zeeraa/connectors probe-answer-fields
 *
 * Read-only. It reads leads and prints counts; it writes nothing.
 */
import { SalesforceClient } from '../src/salesforce/client';
import { inboundClause, parseLeadExclusion } from '../src/salesforce/exclusion';

const required = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_PRIVATE_KEY_BASE64', 'SF_LOGIN_URL', 'MATCH'] as const;
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Cannot run: ${missing.join(', ')} not set.`);
  console.error('MATCH is a case-insensitive regular expression tried against every value.');
  process.exit(2);
}

const object = process.env.SOBJECT ?? 'Lead';
const since = process.env.SINCE ?? '2026-06-01';
const match = new RegExp(process.env.MATCH!, 'i');

/**
 * Fields this sweep will not read, whatever their values look like.
 *
 * A nine-digit tax or social security number is money-shaped to a regular
 * expression and is not an answer to anything this product asks. A probe that
 * reads one has put it somewhere it does not belong, and a probe that prints
 * one has leaked it — so the exclusion is by field name, before any value is
 * fetched, rather than by filtering the output afterwards.
 */
const PII = /(ssn|ein|tax_?id|social|dob|birth|licen[cs]e|passport|routing|account_?no|bank_?acct|card_?no)/i;

/** Identifiers, URLs and tracking parameters: never an answer to a question. */
const NOISE = /(^id$|_id$|url|link|phone|mobile|fax|zip|postal|ip_|utm|gclid|fbclid|email|street|user_agent)/i;

const client = new SalesforceClient({
  clientId: process.env.SF_CLIENT_ID!,
  username: process.env.SF_USERNAME!,
  privateKeyBase64: process.env.SF_PRIVATE_KEY_BASE64!,
  loginUrl: process.env.SF_LOGIN_URL!,
});

const clause = object === 'Lead' && process.env.LEAD_EXCLUSION
  ? inboundClause(parseLeadExclusion(JSON.parse(process.env.LEAD_EXCLUSION)))
  : null;
const where = [clause, `CreatedDate >= ${since}T00:00:00Z`].filter(Boolean).join(' AND ');

const describe = await client.describe(object);
const fields = describe.fields
  .filter((f) => ['string', 'textarea', 'picklist', 'multipicklist'].includes(f.type))
  .filter((f) => !PII.test(f.name) && !NOISE.test(f.name))
  .map((f) => f.name);

console.log(`Scanning ${fields.length} textual ${object} fields since ${since}.`);
console.log(`Excluded by name: ${describe.fields.filter((f) => PII.test(f.name)).length} sensitive, ` +
  `${describe.fields.filter((f) => NOISE.test(f.name)).length} identifier or tracking.\n`);

const hits = new Map<string, Map<string, number>>();
const populated = new Map<string, number>();
let total = 0;

// Batched, because a SELECT naming every field exceeds the URL length a query
// endpoint accepts — and a failed batch is reported rather than skipped
// silently, since a field that was never read looks exactly like one that
// holds nothing.
for (let i = 0; i < fields.length; i += 45) {
  const batch = fields.slice(i, i + 45);
  let rows: Record<string, unknown>[];
  try {
    rows = await client.query<Record<string, unknown>>(
      `SELECT Id,${batch.join(',')} FROM ${object}${where ? ` WHERE ${where}` : ''}`,
    );
  } catch (error) {
    console.error(`  batch ${i}-${i + batch.length} failed: ${(error as Error).message.slice(0, 120)}`);
    continue;
  }
  total = Math.max(total, rows.length);
  for (const row of rows) {
    for (const field of batch) {
      const value = row[field];
      if (value == null || String(value).trim() === '') continue;
      const text = String(value).trim();
      populated.set(field, (populated.get(field) ?? 0) + 1);
      // Long free text is a note that happens to mention the thing, not a
      // field that answers it.
      if (text.length > 120 || !match.test(text)) continue;
      const seen = hits.get(field) ?? new Map<string, number>();
      seen.set(text, (seen.get(text) ?? 0) + 1);
      hits.set(field, seen);
    }
  }
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`## ${object} records in range: ${total.toLocaleString()}`);
console.log(`## fields whose values match /${process.env.MATCH}/i\n`);

const ordered = [...hits].sort((a, b) => sum(b[1]) - sum(a[1]));
if (ordered.length === 0) console.log('   none — widen MATCH, or the answer is on another object');
for (const [field, values] of ordered) {
  const n = sum(values);
  console.log(
    `   ${field}\n      ${n} matching of ${populated.get(field) ?? 0} populated` +
      `${total ? ` (${((n / total) * 100).toFixed(1)}% of records)` : ''}`,
  );
  [...values]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([value, count]) => console.log(`         ${String(count).padStart(5)}  ${JSON.stringify(value)}`));
}

console.log(
  '\nA match is not a mapping. Check what the field *means* before adding it: ' +
    '`Desired_Funding_Amount__c` holds `$5,000 - $25,000` and is how much the ' +
    'merchant wants to borrow, not what they earn.',
);
