-- This migration removes three columns of `principals` that the Worker does not read or write:
-- - `agent_resources` held the resource limits of an agent or a service account. Since the change "Access
--   follows membership", the membership of a resource decides where an agent can act.
-- - `service_scopes` and `service_resources` held the scopes and the limits of a service account. Migration
--   0027 copied them to `agent_scopes` and `agent_resources`. The Worker does not read them after 0027.
-- The deploy applies the migrations while the Worker from before runs. That Worker must not use these columns,
-- so a Worker from before "Access follows membership" must not run when this migration starts. After this
-- migration, a rollback to such a Worker is not supported (docs/self-hosting.md).
-- No index, trigger, view, key or CHECK constraint names these columns, so SQLite can drop each one in place.
-- The statement markers let a fresh reset replay this file without a SQL parser.
ALTER TABLE principals DROP COLUMN agent_resources;
--> statement-breakpoint
ALTER TABLE principals DROP COLUMN service_scopes;
--> statement-breakpoint
ALTER TABLE principals DROP COLUMN service_resources;
