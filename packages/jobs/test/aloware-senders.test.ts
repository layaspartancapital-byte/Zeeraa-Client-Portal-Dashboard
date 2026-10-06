/**
 * Two senders, one call.
 *
 * While Aloware's own webhook runs beside the Zap, the properties that matter
 * are: a direct post in shadow writes no call but leaves its copy; the Zap's
 * path is unchanged; once live, both write the same row (the dedupe is the
 * Communication ID); and the bucket's `accepted` counts that call once, which
 * is what the reconciliation compares with stored calls.
 *
 * Scoped to a tenant this file creates and deletes: packages test concurrently
 * against one Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { ingestCallEvents } from '../src/aloware/webhook';
import { recordWebhookDelivery } from '../src/webhook-delivery';

const SLUG = `senders-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let tenantId: string;

const native = (id: string) => ({
  event: 'OutboundPhoneCall-DispositionCompleted',
  body: {
    id,
    type: '1',
    direction: '2',
    current_status: 'completed',
    disposition_status: 'completed',
    talk_time: '40',
    duration: '44',
    lead_number: '+15415550123',
    contact_id: '6896898',
    user_id: '42',
    created_at: '2026-10-06 14:22:28',
  },
});
const zap = (id: string) => ({
  ID: Number(id),
  'Created At': '2026-10-06 14:22:28',
  'Current Status': 'completed',
  'Disposition Status': 'completed',
  Type: 1,
  Direction: 2,
  'Talk Time': 40,
  Duration: 44,
  'Contact Id': 6896898,
  'Lead Number': '+15415550123',
});

const read = <T>(fn: (tx: Parameters<Parameters<typeof withMaintenance>[1]>[0]) => Promise<T>) =>
  withMaintenance(getMaintenanceDb(), fn);
const callsWith = (id: string) =>
  read((tx) =>
    tx.select().from(schema.calls).where(and(eq(schema.calls.tenantId, tenantId), eq(schema.calls.externalId, id))),
  );
const copiesOf = (id: string) =>
  read((tx) =>
    tx
      .select()
      .from(schema.callDeliveries)
      .where(and(eq(schema.callDeliveries.tenantId, tenantId), eq(schema.callDeliveries.externalId, id))),
  );
const setMode = (mode: 'shadow' | 'live') =>
  read(async (tx) => {
    await tx
      .delete(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenantId), eq(schema.tenantConfig.key, 'aloware')));
    await tx.insert(schema.tenantConfig).values({
      tenantId,
      key: 'aloware',
      value: { connectedMinTalkSeconds: 30, directMode: mode, agents: { '42': 'Agent Forty-Two' } },
    });
  });

beforeAll(async () => {
  tenantId = await read(async (tx) => {
    const [row] = await tx
      .insert(schema.tenants)
      .values({ name: 'Senders fixture', slug: SLUG, timezone: 'America/New_York' })
      .returning();
    return row!.id;
  });
});

afterAll(async () => {
  await read((tx) => tx.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)));
});

describe('a direct post in shadow', () => {
  it('writes no call, and keeps its copy for the comparison', async () => {
    const result = await ingestCallEvents(SLUG, [native('9001')], 'aloware');
    expect(result).toMatchObject({ accepted: 1, written: 0, inserted: 0, shadow: true });
    expect(await callsWith('9001')).toHaveLength(0);

    const [copy] = await copiesOf('9001');
    expect(copy).toMatchObject({ sender: 'aloware', written: false, direction: 'outbound', agentExternalId: '42' });
    expect(copy!.occurredAt.toISOString()).toBe('2026-10-06T14:22:28.000Z');
  });

  it('is shadow by default, with no config row at all', async () => {
    const result = await ingestCallEvents(SLUG, [native('9002')], 'aloware');
    expect(result!.shadow).toBe(true);
  });
});

describe('the Zap, unchanged', () => {
  it('writes the call and keeps its own copy', async () => {
    const result = await ingestCallEvents(SLUG, [zap('9001')], 'zapier');
    expect(result).toMatchObject({ accepted: 1, written: 1, inserted: 1, shadow: false });
    expect(await callsWith('9001')).toHaveLength(1);
    const copies = await copiesOf('9001');
    expect(copies.map((c) => c.sender).sort()).toEqual(['aloware', 'zapier']);
  });
});

describe('a direct post once live', () => {
  it('updates the Zap’s row rather than adding one, and fills the agent', async () => {
    await setMode('live');
    const result = await ingestCallEvents(SLUG, [native('9001')], 'aloware');
    expect(result).toMatchObject({ accepted: 1, written: 1, inserted: 0, shadow: false });

    const rows = await callsWith('9001');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentExternalId: '42', agentName: 'Agent Forty-Two' });

    // And the Zap's later copy, which carries no agent, does not erase it.
    await ingestCallEvents(SLUG, [zap('9001')], 'zapier');
    expect((await callsWith('9001'))[0]).toMatchObject({ agentName: 'Agent Forty-Two' });

    const [copy] = (await copiesOf('9001')).filter((c) => c.sender === 'aloware');
    expect(copy).toMatchObject({ written: true, deliveries: 2 });
  });

  it('writes a call the Zap never sent', async () => {
    const result = await ingestCallEvents(SLUG, [native('9003')], 'aloware');
    expect(result).toMatchObject({ written: 1, inserted: 1 });
    expect(await callsWith('9003')).toHaveLength(1);
  });
});

describe('the day’s bucket', () => {
  it('counts per sender, and counts a call twice delivered once in accepted', async () => {
    const now = new Date('2026-10-06T15:00:00Z');
    await recordWebhookDelivery(SLUG, 'aloware', { kind: 'read', accepted: 1, written: 1, inserted: 1, rejected: [], sender: 'zapier' }, now);
    await recordWebhookDelivery(SLUG, 'aloware', { kind: 'read', accepted: 1, written: 1, inserted: 0, rejected: [], sender: 'aloware' }, now);
    await recordWebhookDelivery(SLUG, 'aloware', { kind: 'refused', reason: 'unauthenticated', sender: 'aloware', sample: { auth: { scheme: 'basic' } } }, now);

    const [bucket] = await read((tx) =>
      tx.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.tenantId, tenantId)),
    );
    expect(bucket!.accepted).toBe(1);
    expect(bucket!.senders).toEqual({
      zapier: { received: 1, accepted: 1, rejected: 0, refused: 0 },
      aloware: { received: 2, accepted: 1, rejected: 0, refused: 1 },
    });
    expect(bucket!.samples).toEqual({ 'aloware:refused': { auth: { scheme: 'basic' } } });
  });
});
