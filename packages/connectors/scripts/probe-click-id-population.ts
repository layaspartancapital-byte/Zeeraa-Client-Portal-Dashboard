/**
 * How much of each click-ID field is actually populated, and how much of it
 * reaches an opportunity.
 *
 *   pnpm --filter @zeeraa/connectors probe-click-id-population
 *
 * Read-only: a count per field, nothing else. `probe-click-ids` answers whether
 * a field exists, is readable and is mapped; this answers whether anybody has
 * ever filled it in, which is the question that decides whether a channel is
 * worth connecting.
 *
 * The third column is the one that matters. A field can be well populated on
 * Lead and still contribute nothing, because Salesforce lead field mapping
 * copies at the moment of conversion and never retrospectively — so what is
 * recoverable today is the converted leads that carry it, not the leads that
 * carry it.
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

/** Spartan's names. Another org's differ; this is a diagnostic, not a mapping. */
const FIELDS: { platform: string; lead: string; opportunity?: string }[] = [
  { platform: 'google_ads', lead: 'gclid__c', opportunity: 'gclid__c' },
  { platform: 'meta', lead: 'acq_fbclid__c', opportunity: 'acq_fbclid__c' },
  { platform: 'microsoft_ads', lead: 'msclkid__c', opportunity: 'msclkid__c' },
  { platform: 'linkedin_ads', lead: 'Li_Fat_ID__c', opportunity: 'Li_Fat_ID__c' },
  { platform: 'google_ads (gbraid)', lead: 'Gbraid__c', opportunity: 'Gbraid__c' },
  { platform: 'google_ads (wbraid)', lead: 'Wbraid__c', opportunity: 'Wbraid__c' },
  { platform: 'tiktok', lead: 'TTCLID__c' },
];

// `SELECT COUNT()` returns a bare totalSize with no row, so an aliased
// COUNT(Id) is the form that comes back as data. `expr0` is reserved.
const count = async (soql: string): Promise<number> => {
  const rows = await client.query<{ n: number }>(soql);
  return rows[0]?.n ?? 0;
};

const leads = await count('SELECT COUNT(Id) n FROM Lead');
const opportunities = await count('SELECT COUNT(Id) n FROM Opportunity');
console.log(`Lead: ${leads.toLocaleString()}   Opportunity: ${opportunities.toLocaleString()}\n`);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(
  `${pad('platform', 22)}${pad('lead field', 18)}${pad('on Lead', 10)}` +
    `${pad('converted', 11)}${pad('→ opp', 8)}on Opportunity`,
);

for (const f of FIELDS) {
  const onLead = await count(`SELECT COUNT(Id) n FROM Lead WHERE ${f.lead} != null`);
  const converted = await count(
    `SELECT COUNT(Id) n FROM Lead WHERE ${f.lead} != null AND IsConverted = true`,
  );
  const toOpp = await count(
    `SELECT COUNT(Id) n FROM Lead WHERE ${f.lead} != null AND IsConverted = true ` +
      'AND ConvertedOpportunityId != null',
  );
  const onOpp = f.opportunity
    ? String(await count(`SELECT COUNT(Id) n FROM Opportunity WHERE ${f.opportunity} != null`))
    : '(no field)';

  console.log(
    `${pad(f.platform, 22)}${pad(f.lead, 18)}${pad(String(onLead), 10)}` +
      `${pad(String(converted), 11)}${pad(String(toOpp), 8)}${onOpp}`,
  );
}

console.log(
  '\nA low "on Opportunity" against a healthy "→ opp" is expected rather than ' +
    'broken: the conversion mapping only fires for conversions after it was ' +
    'created, and the converted-Lead backfill is what recovers the rest.',
);
