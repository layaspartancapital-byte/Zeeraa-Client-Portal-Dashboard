import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { connectionStatusEnum, notificationChannelPrefEnum, roleEnum } from './enums';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** All ingested dates are normalised to this zone at write time (§6). */
    timezone: text('timezone').notNull().default('America/New_York'),
    currency: text('currency').notNull().default('USD'),
    /** Drives the persistent 3px stripe that distinguishes adjacent tabs (§12). */
    accentColor: text('accent_color').notNull().default('#2F5D8C'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenants_slug_key').on(t.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The login identifier. Compared case-insensitively; never emailed to. */
    email: text('email').notNull(),
    name: text('name'),
    image: text('avatar_url'),
    title: text('title'),
    /**
     * argon2id, in PHC string format — the parameters travel with the hash, so
     * raising the cost later does not invalidate what is already stored.
     *
     * Null means this account cannot sign in at all. That is a real state, not
     * a gap: a user row can exist before anybody has set a password on it, and
     * the sign-in path treats null as a failed attempt rather than as an
     * account with no password.
     */
    passwordHash: text('password_hash'),
    /**
     * Set when an admin writes the password, cleared when the person replaces
     * it. Every authenticated route sends them to `/change-password` while it
     * is true — an initial password has been read aloud or pasted into a chat,
     * so it is a delivery mechanism, not a credential.
     */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    emailPreference: notificationChannelPrefEnum('email_preference').notNull().default('instant'),
    slackEnabled: boolean('slack_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_user_tenant_key').on(t.userId, t.tenantId),
    index('memberships_tenant_idx').on(t.tenantId),
  ],
);

/**
 * Per-tenant platform credentials. The credential blob is AES-256-GCM
 * ciphertext; per-tenant OAuth and Slack tokens live here rather than in env
 * vars so that onboarding a client never requires a redeploy (§14).
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    accountIdentifier: text('account_identifier').notNull(),
    credentialsEncrypted: text('credentials_encrypted'),
    /** Non-secret connector settings: Salesforce audience URL, Slack channel. */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    status: connectionStatusEnum('status').notNull().default('not_configured'),
    /** Plain description of the outstanding client-side dependency (§9.5). */
    blockedReason: text('blocked_reason'),
    blockedSince: timestamp('blocked_since', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connections_tenant_platform_account_key').on(
      t.tenantId,
      t.platform,
      t.accountIdentifier,
    ),
  ],
);

// --- Sessions ----------------------------------------------------------------
// Not tenant-scoped: identity is global, authorisation is the membership row.
//
// A session is a row rather than a signed token, so ending one takes effect on
// the next request instead of whenever a token would have expired. That is what
// makes an admin's password reset able to close the sessions it invalidates.

export const sessions = pgTable('sessions', {
  /** 256 bits from `randomBytes`, base64url. The cookie carries this verbatim. */
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
  connections: many(connections),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [memberships.tenantId], references: [tenants.id] }),
}));
