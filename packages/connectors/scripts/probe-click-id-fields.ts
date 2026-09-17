/**
 * Read-only audit of the click-ID fields on Lead and Opportunity.
 *
 *   pnpm --filter @zeeraa/connectors probe-click-ids
 *
 * Writes nothing. Every call is a GET: two describes, one SOQL select per
 * object, and a Tooling API read of the lead-conversion mappings.
 *
 * Three questions, and the second is the one that costs weeks when it is
 * skipped:
 *
 *   1. Which click-ID fields exist, under exactly which API name, type and
 *      length.
 *   2. Whether the integration user can actually read each one. A field hidden
 *      by field-level security is omitted from the API response and is
 *      indistinguishable from a field that was never created — a column of
 *      nulls that looks like an absence of clicks rather than an absence of
 *      permission.
 *   3. Whether the Lead → Opportunity mapping exists, because a field on both
 *      objects with no mapping between them stays null on every opportunity
 *      forever, and looks exactly like a field that is simply never populated.
 */
import { SalesforceClient, SalesforceApiError, type DescribeField } from '../src/salesforce/client';
import { SalesforceAuthError, type JwtConfig } from '../src/salesforce/jwt';

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
} satisfies JwtConfig);

/** What the click-ID fields are called by the parameter they carry. */
const CLICK_ID_CONCEPTS = [
  { param: 'gclid', platform: 'Google Ads' },
  { param: 'gbraid', platform: 'Google Ads (iOS app-to-web)' },
  { param: 'wbraid', platform: 'Google Ads (web-to-app)' },
  { param: 'msclkid', platform: 'Microsoft Ads' },
  { param: 'fbclid', platform: 'Meta' },
  { param: 'li_fat_id', platform: 'LinkedIn Ads' },
  { param: 'ttclid', platform: 'TikTok' },
] as const;

/** Any field whose name mentions a click-ID parameter, however it is spelled. */
function clickIdFields(fields: DescribeField[]) {
  return fields
    .map((f) => {
      const lower = f.name.toLowerCase();
      const concept = CLICK_ID_CONCEPTS.find((c) => lower.includes(c.param));
      return concept ? { field: f, concept } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.field.name.localeCompare(b.field.name));
}

function describeLine(f: DescribeField): string {
  const size =
    f.type === 'string' || f.type === 'textarea'
      ? `Text(${f.length ?? '?'})`
      : f.type === 'double' || f.type === 'currency'
        ? `${f.type}(${f.precision ?? '?'},${f.scale ?? '?'})`
        : f.type;
  return size;
}

/**
 * Proves readability by reading.
 *
 * The describe already reflects the running user's field-level security, but
 * "absent from a describe" and "cannot be selected" have been known to diverge,
 * and the thing that actually matters is whether a SELECT returns the column.
 * So this selects them, one at a time, and reports precisely which fail.
 */
async function confirmSelectable(
  object: string,
  names: string[],
): Promise<{ readable: string[]; refused: { name: string; reason: string }[] }> {
  const readable: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const name of names) {
    try {
      await client.query(`SELECT Id, ${name} FROM ${object} LIMIT 1`);
      readable.push(name);
    } catch (error) {
      const message =
        error instanceof SalesforceApiError
          ? (JSON.parse(error.body)?.[0]?.message ?? error.body).split('\n').pop()
          : String(error);
      refused.push({ name, reason: String(message).trim() });
    }
  }
  return { readable, refused };
}

try {
  const token = await client.authenticate();
  console.log(`Connected to ${token.instanceUrl} as ${process.env.SF_USERNAME}`);
  console.log(`API v${await client.version()} · read-only\n`);

  const [lead, opportunity] = await Promise.all([
    client.describe('Lead'),
    client.describe('Opportunity'),
  ]);

  for (const [label, describe] of [
    ['Opportunity', opportunity],
    ['Lead', lead],
  ] as const) {
    const found = clickIdFields(describe.fields);
    console.log(`── ${label} · ${found.length} click-ID field(s) ──`);
    if (found.length === 0) {
      console.log('  none\n');
      continue;
    }
    for (const { field, concept } of found) {
      console.log(
        `  ${field.name.padEnd(22)} ${describeLine(field).padEnd(12)} ` +
          `custom=${field.custom} permissionable=${field.permissionable ?? '?'}  ` +
          `[${concept.platform}]`,
      );
    }

    const { readable, refused } = await confirmSelectable(
      describe.name,
      found.map((f) => f.field.name),
    );
    console.log(`  selectable by this user: ${readable.length}/${found.length}`);
    for (const r of refused) console.log(`    REFUSED ${r.name}: ${r.reason}`);
    console.log('');
  }

  // --- Pairing: the same concept on both objects, same name, type and length --
  console.log('── Lead ↔ Opportunity pairing ──');
  const leadByConcept = new Map(clickIdFields(lead.fields).map((f) => [f.concept.param, f.field]));
  const oppByConcept = new Map(
    clickIdFields(opportunity.fields).map((f) => [f.concept.param, f.field]),
  );
  for (const concept of CLICK_ID_CONCEPTS) {
    const l = leadByConcept.get(concept.param);
    const o = oppByConcept.get(concept.param);
    if (!l && !o) continue;
    const problems: string[] = [];
    if (!l) problems.push('no Lead field — nothing to map from');
    if (!o) problems.push('no Opportunity field — nothing to map to');
    if (l && o) {
      if (l.name !== o.name) problems.push(`API names differ: Lead ${l.name} vs Opportunity ${o.name}`);
      if (l.type !== o.type) problems.push(`types differ: ${l.type} vs ${o.type}`);
      if (l.length !== o.length) problems.push(`lengths differ: ${l.length} vs ${o.length}`);
    }
    console.log(
      `  ${concept.param.padEnd(10)} Lead=${l?.name ?? '—'} Opportunity=${o?.name ?? '—'}` +
        (problems.length ? `\n    ${problems.join('\n    ')}` : '  OK'),
    );
  }
  console.log('');

  // --- The mapping itself ---------------------------------------------------
  //
  // Read from `LeadConvertSettings.Metadata` in the Tooling API. The
  // `ObjectMapping` / `ObjectMappingField` objects are the documented route and
  // are simply not present in this org's Tooling API (INVALID_TYPE, not a
  // permission), so this is the one that answers the question.
  console.log('── Lead → Opportunity field mappings ──');
  try {
    const settings = await client.toolingQuery<{
      Metadata?: {
        objectMapping?: {
          inputObject: string;
          outputObject: string;
          mappingFields?: { inputField: string; outputField: string }[];
        }[];
      };
    }>('SELECT Id, Metadata FROM LeadConvertSettings');

    const objectMappings = settings[0]?.Metadata?.objectMapping ?? [];
    if (objectMappings.length === 0) {
      console.log('  LeadConvertSettings returned no object mappings at all.');
    }

    for (const mapping of objectMappings) {
      const pairs = mapping.mappingFields ?? [];
      const clickIdPairs = pairs.filter((p) =>
        CLICK_ID_CONCEPTS.some((c) => p.inputField.toLowerCase().includes(c.param)),
      );
      console.log(
        `  ${mapping.inputObject} → ${mapping.outputObject}: ${pairs.length} mapped field(s), ` +
          `${clickIdPairs.length} of them click IDs`,
      );
      for (const p of clickIdPairs) console.log(`    ${p.inputField} → ${p.outputField}`);

      if (mapping.outputObject === 'Opportunity') {
        const mapped = new Set(clickIdPairs.map((p) => p.inputField.toLowerCase()));
        const unmapped = [...leadByConcept.values()].filter(
          (f) => !mapped.has(f.name.toLowerCase()),
        );
        if (unmapped.length > 0) {
          console.log(`    NOT mapped to Opportunity: ${unmapped.map((f) => f.name).join(', ')}`);
          console.log(
            '    Until these are mapped, every click-ID field on Opportunity stays null on ' +
              'every converted lead. Setup → Object Manager → Lead → Map Lead Fields.',
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof SalesforceApiError ? error.body.slice(0, 200) : String(error);
    console.log(`  Could not read LeadConvertSettings through the Tooling API: ${message}`);
    console.log('  Not an answer about the org — check Setup → Object Manager → Lead →');
    console.log('  Fields & Relationships → Map Lead Fields by hand.');
  }
} catch (error) {
  if (error instanceof SalesforceAuthError) {
    console.error(`Authentication failed: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
