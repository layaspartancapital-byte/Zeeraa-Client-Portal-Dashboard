import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy';

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
