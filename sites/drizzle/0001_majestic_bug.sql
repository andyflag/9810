ALTER TABLE `invitations` ADD `claim_id` text;--> statement-breakpoint
CREATE INDEX `invitations_workspace_email` ON `invitations` (`workspace_id`,`email`);--> statement-breakpoint
CREATE INDEX `audit_workspace_created` ON `audit` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `memberships_workspace_user` ON `memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user` ON `memberships` (`user_id`);