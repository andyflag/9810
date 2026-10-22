import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  settings: text('settings').notNull(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(0),
  mutationId: text('mutation_id'),
  updatedAt: text('updated_at').notNull(),
});
export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
  },
  (table) => [
    index('memberships_workspace_user').on(table.workspaceId, table.userId),
    index('memberships_user').on(table.userId),
  ],
);
export const preferences = sqliteTable('preferences', {
  userId: text('user_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
});
export const audit = sqliteTable(
  'audit',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('audit_workspace_created').on(table.workspaceId, table.createdAt, table.id)],
);
export const invitations = sqliteTable(
  'invitations',
  {
    tokenHash: text('token_hash').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: text('used_at'),
    claimId: text('claim_id'),
  },
  (table) => [index('invitations_workspace_email').on(table.workspaceId, table.email)],
);
