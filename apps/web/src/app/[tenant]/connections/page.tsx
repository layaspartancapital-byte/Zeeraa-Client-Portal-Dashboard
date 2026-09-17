import { asc, eq } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { Panel } from '@/components/Panel';
import { canManageConnections } from '@zeeraa/core';
import { queryTenant, requireRole } from '@/lib/tenant';

export const metadata = { title: 'Connections' };

const PLATFORM_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  google_ads: 'Google Ads',
  microsoft_ads: 'Microsoft Ads',
  meta: 'Meta',
  linkedin_ads: 'LinkedIn Ads',
  ga4: 'GA4',
  search_console: 'Search Console',
  semrush: 'Semrush',
  call_tracking: 'Call tracking',
};

/**
 * Connection health. Failures state what broke and what to do, in the
 * interface's voice, without apologising.
 *
 * `waiting_on_client` renders in graphite as a plain description of what is
 * needed and since when — it is a dependency, not a fault.
 */
export default async function Connections({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canManageConnections);

  const connections = await queryTenant(session, (tx) =>
    tx
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.tenantId, session.tenant.id))
      .orderBy(asc(schema.connections.platform)),
  );

  return (
    <Panel
      title="Connections"
      description="One row per platform. Nothing here is configured yet — credentials are added per client and never by redeploy."
    >
      <div className="table-scroll overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left text-[12px] text-graphite">
              <th scope="col" className="px-5 py-2 font-normal">Platform</th>
              <th scope="col" className="px-5 py-2 font-normal">State</th>
              <th scope="col" className="px-5 py-2 font-normal">Last successful sync</th>
              <th scope="col" className="px-5 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => {
              const blocked = c.status === 'waiting_on_client';
              return (
                <tr key={c.id} className="border-b border-rule align-top last:border-b-0">
                  <td className="px-5 py-3 text-ink">
                    {PLATFORM_LABELS[c.platform] ?? c.platform}
                  </td>
                  <td className="px-5 py-3">
                    <span className={blocked ? 'text-graphite' : 'text-ink'}>
                      {blocked
                        ? 'Waiting on client'
                        : c.status === 'not_configured'
                          ? 'Not configured'
                          : c.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 numeric text-graphite">Never</td>
                  <td className="max-w-md px-5 py-3 text-[12px] leading-relaxed text-graphite">
                    {c.blockedReason ??
                      c.lastError ??
                      'Credentials have not been supplied. Add them in the connection settings to begin syncing.'}
                    {blocked && c.blockedSince && (
                      <span className="text-provisional">
                        {' '}
                        · outstanding since {c.blockedSince.toISOString().slice(0, 10)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
