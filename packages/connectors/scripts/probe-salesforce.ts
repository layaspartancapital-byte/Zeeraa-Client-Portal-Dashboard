/**
 * Answers the four questions phase 2 depends on, against a real org.
 *
 *   SF_CLIENT_ID=... SF_USERNAME=... SF_PRIVATE_KEY_BASE64=... \
 *   SF_LOGIN_URL=https://login.salesforce.com \
 *   pnpm --filter @zeeraa/connectors probe
 *
 * Read-only. It inspects conversions that have already happened rather than
 * creating a test lead, because real history is better evidence than one
 * synthetic record and a probe should not write to a client's CRM.
 *
 * Exits non-zero if anything is blocked, so it can gate the phase.
 */
import { SalesforceClient } from '../src/salesforce/client';
import { runAllProbes } from '../src/salesforce/probe';
import { formatInventory, safeLeadFieldInventory } from '../src/salesforce/inventory';
import { SalesforceAuthError, type JwtConfig } from '../src/salesforce/jwt';

const required = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_PRIVATE_KEY_BASE64', 'SF_LOGIN_URL'] as const;
const missing = required.filter((k) => !process.env[k]);

if (missing.length > 0) {
  console.error(`Cannot probe: ${missing.join(', ')} not set.\n`);
  console.error('SF_USERNAME is the integration user’s Salesforce username and is');
  console.error('the `sub` claim of the JWT. It is not listed in §14 of the brief,');
  console.error('but the JWT bearer flow cannot work without it.\n');
  console.error('SF_LOGIN_URL is https://login.salesforce.com for production and');
  console.error('https://test.salesforce.com for a sandbox.');
  process.exit(2);
}

const config: JwtConfig = {
  clientId: process.env.SF_CLIENT_ID!,
  username: process.env.SF_USERNAME!,
  privateKeyBase64: process.env.SF_PRIVATE_KEY_BASE64!,
  loginUrl: process.env.SF_LOGIN_URL!,
};

const client = new SalesforceClient(config);

try {
  const token = await client.authenticate();
  console.log(`Connected to ${token.instanceUrl}`);
  console.log(`API version v${await client.version()}`);
  console.log(`Scopes: ${token.scope ?? '(not reported)'}\n`);
} catch (error) {
  if (error instanceof SalesforceAuthError) {
    console.error(`Could not authenticate: ${error.failure.description}\n`);
    console.error(error.failure.remedy);
    console.error(
      `\nThis is ${error.failure.waitingOnClient ? 'a change in the client’s org' : 'a change on our side'}.`,
    );
    process.exit(1);
  }
  throw error;
}

const findings = await runAllProbes(client);

let blocked = 0;
for (const f of findings) {
  const mark = f.status === 'ok' ? 'ok     ' : f.status === 'degraded' ? 'PARTIAL' : 'BLOCKED';
  if (f.status === 'blocked') blocked += 1;
  console.log(`${mark}  ${f.question}`);
  console.log(`         ${f.summary}`);
  for (const line of f.detail) console.log(`           · ${line}`);
  if (f.remedy) console.log(`         → ${f.remedy}`);
  console.log();
}

// --- Lead field inventory ----------------------------------------------------
// Which field carries which concept, and how often it is actually filled in.
console.log('Lead field inventory\n');
const { inventories, error } = await safeLeadFieldInventory(client);

if (error) {
  console.error(`Could not read the field inventory: ${error}\n`);
} else {
  console.log(formatInventory(inventories));
}

const unusable = inventories.filter((i) => i.absent || i.belowThreshold);
if (unusable.length > 0) {
  console.log('Below 50% populated, or absent entirely:');
  for (const i of unusable) {
    console.log(`  \u00b7 ${i.concept}${i.absent ? ' (no field found)' : ''}`);
  }
  console.log(
    '\nEach of these is a slice to cut rather than to ship. A field nobody fills\n' +
      'in produces a chart that looks like a measurement and is not one.\n',
  );
}

if (blocked > 0) {
  console.error(
    `${blocked} of ${findings.length} questions came back blocked. Do not build ` +
      'attribution or stage events on top of these until they are resolved.',
  );
  process.exit(1);
}
console.log('All six questions answered. Phase 2 can proceed on these foundations.');
