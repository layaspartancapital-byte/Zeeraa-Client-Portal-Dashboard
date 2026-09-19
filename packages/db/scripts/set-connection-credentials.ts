/**
 * Encrypts a platform's credentials into a tenant's connection row.
 *
 *   pnpm --filter @zeeraa/db set-credentials <tenant-slug> <platform>
 *
 * Credentials arrive as environment variables — Codespaces secrets locally,
 * Vercel environment variables in deployment — and stop being environment
 * variables here. Every credential is per tenant and lives encrypted in
 * `connections.credentials_encrypted`, so onboarding a second client is a row
 * rather than a redeploy (§14). Reading them straight from the environment at
 * sync time would make that impossible the moment a second tenant arrived with
 * its own OAuth client.
 *
 * Maintenance rather than the application role: this writes one tenant's row on
 * nobody's behalf, and the ingestion role has SELECT on `connections` only — by
 * design, since a connector that could rewrite its own credentials is a
 * connector that can lock a client out of their own account.
 *
 * Idempotent. Re-running with a fresh refresh token replaces the stored one and
 * changes nothing else.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { decryptCredentials, encryptCredentials } from '../src/encryption';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

/**
 * Which environment variables carry which platform's secrets, and which of
 * them the connector cannot work without.
 *
 * Per platform, never per client: `GOOGLE_ADS_CLIENT_ID` is the OAuth client of
 * whichever tenant is being configured in this shell, not Spartan's in
 * particular. A second tenant is a second run with a different shell.
 */
const PLATFORMS: Record<
  string,
  { required: Record<string, string>; optional?: Record<string, string> }
> = {
  salesforce: {
    required: {
      clientId: 'SF_CLIENT_ID',
      // The integration user's Salesforce username — the JWT's `sub` claim.
      // Not an email address and not necessarily a working mailbox.
      username: 'SF_USERNAME',
      // base64 of the whole PEM. PEM newlines do not survive an environment
      // variable intact, and a mangled key is the usual cause of a JWT flow
      // that fails with nothing useful in the response.
      privateKeyBase64: 'SF_PRIVATE_KEY_BASE64',
    },
  },

  google_ads: {
    required: {
      clientId: 'GOOGLE_ADS_CLIENT_ID',
      clientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
      refreshToken: 'GOOGLE_ADS_REFRESH_TOKEN',
    },
    optional: {
      // Ignored by Google's servers since the 9 September 2026 sunset. Stored
      // when supplied so an older connection keeps working; its absence is not
      // a misconfiguration and no access level may be inferred from it.
      developerToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
    },
  },

  meta: {
    required: {
      /*
       * A Business Manager system user token. Long-lived rather than eternal:
       * it survives until the system user is removed, the token is revoked, or
       * the app's permissions change — all of which are changes in the client's
       * Business Manager, which is why the connector reports them as
       * `waiting_on_client` rather than as our failure.
       *
       * It goes through this script for the same reason every other credential
       * does. A token read from the environment at request time is one token
       * for the whole deployment, and this platform is multi-tenant: the second
       * client would sync against the first client's ad account.
       */
      accessToken: 'META_ACCESS_TOKEN',
    },
  },
};

const args = process.argv.slice(2);
const rekey = args.includes('--rekey');
const [slug, platform] = args.filter((a) => !a.startsWith('--'));
if (!slug || !platform) {
  throw new Error(
    'Usage: tsx scripts/set-connection-credentials.ts <tenant-slug> <platform> [--rekey]',
  );
}

const spec = PLATFORMS[platform];
if (!spec) {
  throw new Error(
    `No credential mapping for platform "${platform}". Known: ${Object.keys(PLATFORMS).join(', ')}.`,
  );
}

const credentials: Record<string, string> = {};
const missing: string[] = [];
for (const [field, variable] of Object.entries(spec.required)) {
  const value = process.env[variable];
  if (!value) missing.push(variable);
  else credentials[field] = value;
}
if (missing.length > 0) {
  throw new Error(`Not set in this shell: ${missing.join(', ')}.`);
}
for (const [field, variable] of Object.entries(spec.optional ?? {})) {
  const value = process.env[variable];
  if (value) credentials[field] = value;
}

const { db, close } = getOwnerDb();

try {
  await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [connection] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, tenant.id),
          eq(schema.connections.platform, platform),
        ),
      );
    if (!connection) {
      throw new Error(`${tenant.name} has no ${platform} connection row. Seed it first.`);
    }

    /*
     * Refuse a key that disagrees with what this tenant already holds.
     *
     * Credentials are encrypted with whatever ENCRYPTION_KEY is in the shell,
     * and a wrong one writes a blob that looks perfectly fine here and cannot
     * be decrypted by the deployment. Nothing fails until the next sync, and
     * the error then points at the connector rather than at this script.
     *
     * The check is cheap and total: every other credential this tenant holds
     * must decrypt under the current key. If some do not, either the key is
     * stale or the environment is pointed at the wrong deployment, and both are
     * reasons to stop rather than to write. `--rekey` is the deliberate
     * exception — re-encrypting every connection under a new key — and it says
     * so at the call site rather than being inferred from the damage.
     */
    const others = await tx
      .select({
        platform: schema.connections.platform,
        blob: schema.connections.credentialsEncrypted,
      })
      .from(schema.connections)
      .where(eq(schema.connections.tenantId, tenant.id));

    const undecryptable = others
      .filter((row) => row.blob && row.platform !== platform)
      .filter((row) => {
        try {
          decryptCredentials(row.blob!);
          return false;
        } catch {
          return true;
        }
      })
      .map((row) => row.platform);

    if (undecryptable.length > 0 && !rekey) {
      throw new Error(
        `Refusing to write: ${undecryptable.join(', ')} already hold credentials that do ` +
          'not decrypt under the ENCRYPTION_KEY in this shell. Either this key is stale ' +
          'or this is the wrong database — writing now would store a blob the ' +
          'deployment cannot read, and nothing would fail until the next sync. ' +
          'Fix the key, or pass --rekey if you are deliberately re-encrypting every ' +
          'connection under a new one.',
      );
    }

    await tx
      .update(schema.connections)
      .set({
        credentialsEncrypted: encryptCredentials(credentials),
        // The credential was the outstanding dependency; it is no longer
        // outstanding. The status stays as it is until `testConnection` has
        // actually reached the account — stored credentials are not a working
        // connection, and claiming otherwise here would be the connection
        // panel's first lie.
        blockedReason: null,
        blockedSince: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connection.id));

    console.log(`${tenant.name} → ${platform} (${connection.accountIdentifier})`);
    console.log(`  connection id: ${connection.id}`);
    console.log(`  tenant id:     ${tenant.id}`);
    console.log(`  stored fields: ${Object.keys(credentials).sort().join(', ')}`);
    console.log(`  status:        ${connection.status} (unchanged — run the connection test)`);
    if (rekey && undecryptable.length > 0) {
      console.log(
        `  NOTE: ${undecryptable.join(', ')} still hold credentials under the previous ` +
          'key. Re-run this for each of them, or the deployment reads one and not the other.',
      );
    }
  });
} finally {
  await close();
}
