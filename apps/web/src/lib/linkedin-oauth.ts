import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { canManageConnections } from '@zeeraa/core';
import {
  exchangeLinkedInCode,
  linkedInAppFromEnv,
  linkedInAuthorizeUrl,
  linkedInConnector,
  LINKEDIN_SCOPES,
  type LinkedInConfig,
  type LinkedInCredentials,
} from '@zeeraa/connectors';
import { encryptCredentials, schema } from '@zeeraa/db';
import { queryTenant, requireRole } from '@/lib/tenant';

/**
 * LinkedIn's Connect button: the OAuth authorization-code flow, once a year.
 *
 * Only a Zeeraa admin may start it or complete it (`canManageConnections`),
 * and the grant is written through that admin's own tenant-scoped transaction
 * — `tenant_admin_write` on `connections` is what admits it, so the database
 * refuses anybody else whatever this code does.
 *
 * The state is a random value in an HttpOnly, SameSite=Lax cookie scoped to
 * the callback path, alongside the tenant the flow was started for; the
 * callback accepts only a state that matches it, once. The redirect URI is
 * built from the request's own origin, so no host is named in code: on
 * zeeraa.cloud it is exactly the URL registered with LinkedIn.
 */

const COOKIE = 'zeeraa_linkedin_oauth';
const COOKIE_PATH = '/api/oauth/linkedin';

export function linkedInRedirectUri(origin: string): string {
  return `${origin}/api/oauth/linkedin/callback`;
}

/** Checks the viewer, sets the state cookie, and returns LinkedIn's consent URL. */
export async function beginLinkedInConnect(slug: string, origin: string): Promise<string> {
  await requireRole(slug, canManageConnections);
  const state = randomBytes(32).toString('base64url');
  (await cookies()).set({
    name: COOKIE,
    value: `${state}.${slug}`,
    httpOnly: true,
    secure: origin.startsWith('https://'),
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: 600,
  });
  return linkedInAuthorizeUrl(linkedInAppFromEnv(), linkedInRedirectUri(origin), state);
}

export type ConnectOutcome = { slug: string | null; result: 'connected' | 'refused' | 'failed'; detail: string };

/** The callback: verify, exchange, check the grant reads the account, store it. */
export async function completeLinkedInConnect(
  params: { code: string | null; state: string | null; error: string | null; errorDescription: string | null },
  origin: string,
): Promise<ConnectOutcome> {
  const jar = await cookies();
  const held = jar.get(COOKIE)?.value ?? '';
  jar.delete({ name: COOKIE, path: COOKIE_PATH });
  const dot = held.indexOf('.');
  const expected = dot > 0 ? held.slice(0, dot) : '';
  const slug = dot > 0 ? held.slice(dot + 1) : null;

  if (!slug || !params.state || !sameValue(expected, params.state)) {
    return { slug, result: 'refused', detail: 'The sign-in with LinkedIn could not be matched to a Connect started here. Press Connect again.' };
  }
  if (params.error || !params.code) {
    return { slug, result: 'refused', detail: params.errorDescription ?? params.error ?? 'LinkedIn returned no authorization code.' };
  }

  const session = await requireRole(slug, canManageConnections);
  try {
    const grant = await exchangeLinkedInCode(linkedInAppFromEnv(), params.code, linkedInRedirectUri(origin));
    const granted = new Set(grant.scope.split(/[ ,]+/).filter(Boolean));
    const missing = LINKEDIN_SCOPES.filter((s: string) => !granted.has(s));
    if (missing.length > 0) {
      return { slug, result: 'refused', detail: `LinkedIn granted ${grant.scope || 'no scopes'}; ${missing.join(' and ')} is required.` };
    }

    return await queryTenant(session, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.tenantId, session.tenant.id), eq(schema.connections.platform, 'linkedin_ads')));
      if (!row) return { slug, result: 'failed', detail: 'This client has no LinkedIn Ads connection row.' } as const;
      const config = row.config as LinkedInConfig;

      // Before anything is stored: can this grant read the configured account?
      // A member without a role on it would store a grant that fails hourly.
      const health = await linkedInConnector().testConnection({
        id: row.id,
        tenantId: session.tenant.id,
        platform: 'linkedin_ads',
        accountIdentifier: row.accountIdentifier,
        credentials: { accessToken: grant.accessToken },
        config: config as unknown as Record<string, unknown>,
        tenantTimezone: session.tenant.timezone,
        tenantCurrency: session.tenant.currency,
      });
      if (health.state === 'failing' || health.state === 'waiting_on_client') {
        return { slug, result: 'refused', detail: health.detail } as const;
      }

      const credentials: LinkedInCredentials = {
        ...grant,
        authorizedBy: session.viewer.userId,
        authorizedAt: new Date().toISOString(),
      };
      const updated = await tx
        .update(schema.connections)
        .set({
          credentialsEncrypted: encryptCredentials(credentials),
          config: { ...config, refreshTokenExpiresAt: grant.refreshTokenExpiresAt },
          status: health.state,
          blockedReason: null,
          blockedSince: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.connections.id, row.id))
        .returning({ id: schema.connections.id });
      // Under FORCE row level security a refused write changes nothing and
      // raises nothing; the returned row is the evidence it landed.
      if (updated.length !== 1) {
        return { slug, result: 'failed', detail: 'The grant could not be stored for this client.' } as const;
      }
      const ends = grant.refreshTokenExpiresAt ? ` It lasts until ${grant.refreshTokenExpiresAt.slice(0, 10)}.` : '';
      return { slug, result: 'connected', detail: `LinkedIn Ads is connected.${ends}` } as const;
    });
  } catch (error) {
    return { slug, result: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
