import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  settings: text('settings').notNull(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(0),
  mutationId: text('mutation_id'),
  updatedAt: text('updated_at').notNull(),
});
export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
});
export const preferences = sqliteTable('preferences', {
  userId: text('user_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
});
export const audit = sqliteTable('audit', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  createdAt: text('created_at').notNull(),
});
export const invitations = sqliteTable('invitations', {
  tokenHash: text('token_hash').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: text('used_at'),
});
