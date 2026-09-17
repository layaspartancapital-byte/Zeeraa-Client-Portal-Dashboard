import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { assetStatusEnum, mentionSourceEnum } from './enums';
import { tenants, users } from './tenancy';

/**
 * Asset types are a per-tenant configurable list, not an enum in code (§10) —
 * a tenant that never commissions PR placements should not see the option.
 */
export const assetTypes = pgTable(
  'asset_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('asset_types_tenant_key_key').on(t.tenantId, t.key)],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** Links the artifact to the commitment it satisfies, and to its period. */
    commitmentKey: text('commitment_key'),
    periodStart: date('period_start'),
    /** Blob key, always prefixed tenant/{tenant_id}/ — never a public URL. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** For a live PR placement there is no file, only a URL. */
    externalUrl: text('external_url'),
    status: assetStatusEnum('status').notNull().default('draft'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** The audit trail that settles "we never signed off on that" (§10). */
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    changesRequestedReason: text('changes_requested_reason'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedUrl: text('published_url'),
    version: integer('version').notNull().default(1),
    /** Old versions are never deleted; the chain stays visible. */
    supersedesAssetId: uuid('supersedes_asset_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assets_tenant_status_idx').on(t.tenantId, t.status),
    index('assets_tenant_commitment_period_idx').on(t.tenantId, t.commitmentKey, t.periodStart),
  ],
);

export const assetComments = pgTable(
  'asset_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('asset_comments_tenant_asset_idx').on(t.tenantId, t.assetId)],
);

/**
 * Mentions are stored as structured references rather than parsed out of text
 * at render time, so a renamed user still resolves (§10).
 */
export const mentions = pgTable(
  'mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceType: mentionSourceEnum('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    mentionedUserId: uuid('mentioned_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mentions_unique_key').on(t.tenantId, t.sourceType, t.sourceId, t.mentionedUserId),
    index('mentions_tenant_user_idx').on(t.tenantId, t.mentionedUserId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    linkUrl: text('link_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    deliveredEmailAt: timestamp('delivered_email_at', { withTimezone: true }),
    deliveredSlackAt: timestamp('delivered_slack_at', { withTimezone: true }),
  },
  (t) => [index('notifications_tenant_user_created_idx').on(t.tenantId, t.userId, t.createdAt)],
);

/** Append-only. Powers the audit trail and the activity feed. */
export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    verb: text('verb').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_log_tenant_created_idx').on(t.tenantId, t.createdAt)],
);
