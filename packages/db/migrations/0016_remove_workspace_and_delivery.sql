-- ===========================================================================
-- Remove the workspace and the delivery view.
--
-- Zeeraa's delivery flow happens in Slack and Drive. The upload, approval and
-- commitment-tracking features were built against a flow that does not exist,
-- and an empty workspace is worse than no workspace: a board with nothing on it
-- and eleven commitments all reading `Not recorded` reads as a failure to
-- deliver rather than as a feature nobody uses. See `docs/brief-amendments.md`,
-- "§9, §10 and §14 — the workspace and the delivery view are removed".
--
-- **This migration runs after the deploy that removes the code, not before.**
-- For an addition the schema leads; for a removal it follows, or the running
-- application spends the gap querying tables that are already gone.
--
-- Nothing here is recoverable from the application afterwards. What is being
-- dropped held, on production: eleven seeded `deliverable_commitments`, five
-- `sla_commitments` and nine `asset_types` — all configuration written by the
-- seed — and no `assets`, `deliverable_records`, `sla_events`,
-- `asset_comments`, `mentions` or `activity_log` rows, because the review loop
-- shipped on 19 September 2026 and was never used against a real client.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- The approval trigger goes first: it is the only thing outside `public` that
-- these tables own, and dropping `assets` would leave the function behind as a
-- SECURITY DEFINER body referring to a table that no longer exists.
--
-- This is also the one object on production owned by `neondb_owner` rather
-- than `zeeraa_owner`, which is a `BYPASSRLS` role — see `docs/state.md`. It is
-- dropped here rather than re-owned, which closes that gap for good.
-- --------------------------------------------------------------------------
DROP TRIGGER IF EXISTS assets_review_authority ON public.assets;--> statement-breakpoint
DROP FUNCTION IF EXISTS app.enforce_asset_review_authority();--> statement-breakpoint

-- Children before parents. `asset_comments` and `assets` are the only foreign
-- keys among these; every other reference points out at `tenants` and `users`,
-- which stay.
DROP TABLE IF EXISTS "asset_comments";--> statement-breakpoint
DROP TABLE IF EXISTS "mentions";--> statement-breakpoint
DROP TABLE IF EXISTS "assets";--> statement-breakpoint
DROP TABLE IF EXISTS "asset_types";--> statement-breakpoint
DROP TABLE IF EXISTS "deliverable_records";--> statement-breakpoint
DROP TABLE IF EXISTS "deliverable_commitments";--> statement-breakpoint
DROP TABLE IF EXISTS "sla_events";--> statement-breakpoint
DROP TABLE IF EXISTS "sla_commitments";--> statement-breakpoint

-- The audit trail. `lib/assets.ts` was its only writer and nothing ever read
-- it, so it retires with the feature that filled it rather than surviving as a
-- table no code touches.
DROP TABLE IF EXISTS "activity_log";--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The planned mentions feature.
--
-- `slack_user_id` is per membership rather than per user because Zeeraa staff
-- sit in several client workspaces with a different member ID in each. It was
-- only ever going to feed the @mention picker and the Slack side of a mention
-- notification, and neither was built.
--
-- `memberships.slack_enabled` and `notifications.delivered_slack_at` stay:
-- those belong to notification delivery, which is a separate feature and is
-- not being removed here.
-- --------------------------------------------------------------------------
ALTER TABLE "memberships" DROP COLUMN IF EXISTS "slack_user_id";--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Two metric configuration rows whose formulas read tables that no longer
-- exist. `tenant_metrics.formula_key` names a function in `packages/core`, and
-- both of these named one that has gone. Left in place they would be rows the
-- metric loader could never resolve.
--
-- Scoped by `formula_key` rather than by tenant: this is not a client-specific
-- cleanup, it is the removal of two metrics the product no longer computes for
-- anybody.
--
-- **The FORCE bracket is load-bearing, and its absence is silent.**
-- `tenant_metrics` carries FORCE, and its policies name `zeeraa_app`,
-- `zeeraa_jobs` and `zeeraa_maintenance` — not the owner this migration runs
-- as. With FORCE on and no policy applicable, the owner is default-denied, so
-- the DELETE below matches zero rows, reports `DELETE 0` and the migration
-- succeeds having changed nothing. That is what it did when it was first
-- written without this bracket.
--
-- Re-enabled three statements later, in the same transaction. `ALTER TABLE`
-- takes ACCESS EXCLUSIVE, so no other session can read the table across the
-- window, and a failure anywhere in the migration rolls the whole thing back
-- with FORCE still on. This is the one case in this schema where the owner
-- needs to cross tenants and cannot ask `withMaintenance()` to do it, because
-- a migration is SQL rather than a session.
-- --------------------------------------------------------------------------
ALTER TABLE public.tenant_metrics NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DELETE FROM "tenant_metrics"
  WHERE "formula_key" IN ('sla_compliance', 'delivery_completion');--> statement-breakpoint

ALTER TABLE public.tenant_metrics FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Enum types, once nothing references them. `data_source_kind` keeps its
-- `derived_from_assets` value: it is the provenance vocabulary for
-- `data_sources`, Postgres cannot drop one value from an enum, and rewriting
-- the type to remove an unused label is not worth a table rewrite.
DROP TYPE IF EXISTS "public"."asset_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."mention_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."commitment_period";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."deliverable_source";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."sla_event_type";--> statement-breakpoint
