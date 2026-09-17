import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { commitmentPeriodEnum, deliverableSourceEnum, slaEventTypeEnum } from './enums';
import { tenants, users } from './tenancy';

export const deliverableCommitments = pgTable(
  'deliverable_commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    committedQuantity: numeric('committed_quantity', { precision: 12, scale: 2 }).notNull(),
    /**
     * Several commitments are ranges — 30–40 backlinks, 2–3 concurrent tests.
     * Flattening a range to its midpoint would misreport delivery in both
     * directions, so the upper bound is stored rather than discarded.
     */
    committedQuantityMax: numeric('committed_quantity_max', { precision: 12, scale: 2 }),
    period: commitmentPeriodEnum('period').notNull(),
    unit: text('unit').notNull(),
    requiresClientApproval: boolean('requires_client_approval').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('deliverable_commitments_tenant_key_key').on(t.tenantId, t.key)],
);

export const deliverableRecords = pgTable(
  'deliverable_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    commitmentKey: text('commitment_key').notNull(),
    periodStart: date('period_start').notNull(),
    deliveredQuantity: numeric('delivered_quantity', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    notes: text('notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * 'derived_from_assets' rows are maintained by the publication of approved
     * assets and link back to the artifacts; 'manual' rows carry the pencil
     * indicator (§12).
     */
    source: deliverableSourceEnum('source').notNull().default('manual'),
  },
  (t) => [
    uniqueIndex('deliverable_records_upsert_key').on(
      t.tenantId,
      t.commitmentKey,
      t.periodStart,
      t.source,
    ),
    index('deliverable_records_tenant_period_idx').on(t.tenantId, t.periodStart),
  ],
);

export const slaCommitments = pgTable(
  'sla_commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: slaEventTypeEnum('type').notNull(),
    label: text('label').notNull(),
    /** Null where the commitment is a cadence rather than a response time. */
    targetMinutes: integer('target_minutes'),
    cadence: text('cadence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sla_commitments_tenant_type_key').on(t.tenantId, t.type)],
);

export const slaEvents = pgTable(
  'sla_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: slaEventTypeEnum('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    responseMinutes: integer('response_minutes'),
    notes: text('notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sla_events_tenant_type_occurred_idx').on(t.tenantId, t.type, t.occurredAt)],
);
