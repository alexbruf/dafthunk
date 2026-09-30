-- Composio trigger subscriptions. One row per workflow, mirroring bot_triggers:
-- both answer the same question, "which workflow does this inbound delivery
-- run?", so they share a shape.
--
-- `instance_id` is Composio's trigger instance nano id and is the routing key
-- carried on every V3 webhook delivery. It is nullable because a row is written
-- when the user configures the trigger but the upstream subscription is created
-- asynchronously by the reconciler; the window between those two is why
-- reconciliation exists rather than fire-and-forget creation.
--
-- The unique index on `instance_id` is a correctness constraint, not a lookup
-- optimisation: two workflows sharing an instance id would both run for a
-- single upstream event.

CREATE TABLE IF NOT EXISTS `composio_triggers` (
  `workflow_id` text PRIMARY KEY NOT NULL REFERENCES `workflows`(`id`) ON DELETE CASCADE,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `integration_id` text REFERENCES `integrations`(`id`) ON DELETE SET NULL,
  `trigger_slug` text NOT NULL,
  `instance_id` text,
  `config` text,
  `active` integer DEFAULT true NOT NULL,
  `created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `composio_triggers_instance_id_unique_idx` ON `composio_triggers` (`instance_id`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `composio_triggers_organization_id_idx` ON `composio_triggers` (`organization_id`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `composio_triggers_integration_id_idx` ON `composio_triggers` (`integration_id`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `composio_triggers_trigger_slug_idx` ON `composio_triggers` (`trigger_slug`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `composio_triggers_active_idx` ON `composio_triggers` (`active`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `composio_triggers_updated_at_idx` ON `composio_triggers` (`updated_at`);
