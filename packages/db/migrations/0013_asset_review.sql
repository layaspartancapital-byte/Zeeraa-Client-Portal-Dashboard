-- ===========================================================================
-- Asset review: the loop that turns an upload into a delivered figure.
--
-- The tables were already here — `assets` has carried a status, an approver and
-- a version chain since 0000 — but nothing wrote to them, so every commitment
-- on the delivery screen read `Not recorded`. What this migration adds is the
-- part that makes the record trustworthy rather than the part that makes it
-- move:
--
--   * a rejection leaves as much of an audit trail as an approval. Without
--     `changes_requested_by/at` the record could say who approved a piece and
--     not who sent it back, which is precisely the half of "we never signed off
--     on that" the workspace exists to settle;
--   * one asset may be superseded by at most one other, so a version chain is a
--     chain. Two rows pointing at the same predecessor would fork it, and an
--     approved v1 alongside two approved v2s counts one article three times;
--   * approving is a client's act, enforced here rather than by the button
--     being hidden. `canApproveAssets` in packages/core decides what to render;
--     it is not, and must not be, what decides who may approve.
--
-- No new table, so no new policies: `assets` already carries tenant_isolation
-- and maintenance_access, FORCE, and the grants. The trigger below is an
-- additional restriction inside that, never a replacement for it.
-- ===========================================================================

ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "changes_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "changes_requested_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "assets" ADD CONSTRAINT "assets_changes_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("changes_requested_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The version chain. `supersedes_asset_id` has existed since 0000 with neither
-- a foreign key nor a uniqueness constraint behind it.
ALTER TABLE "assets" ADD CONSTRAINT "assets_supersedes_asset_id_assets_id_fk"
  FOREIGN KEY ("supersedes_asset_id") REFERENCES "public"."assets"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "assets" ADD CONSTRAINT "assets_supersedes_not_self"
  CHECK ("supersedes_asset_id" IS NULL OR "supersedes_asset_id" <> "id");--> statement-breakpoint

CREATE UNIQUE INDEX "assets_supersedes_unique" ON "assets"
  USING btree ("tenant_id","supersedes_asset_id")
  WHERE "supersedes_asset_id" IS NOT NULL;--> statement-breakpoint

-- The delivered count is recomputed per (commitment, period) on every decision.
CREATE INDEX IF NOT EXISTS "assets_tenant_commitment_period_status_idx" ON "assets"
  USING btree ("tenant_id","commitment_key","period_start","status");--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Who may move an asset through review.
--
-- SECURITY DEFINER with a pinned search_path, reading membership through
-- `app.effective_role()` — which reads `app.membership_index`, so this needs no
-- elevation and sets no session flag. Same treatment as the policy helpers, and
-- for the same reason: a side effect here would outlive the statement.
--
-- The check is skipped when no user is in context. That is not a hole, it is
-- the seam between the two ways this database is written to: every application
-- write goes through `withTenant`, which always sets a user, so the request
-- path is fully covered. A write with no user is a seed or a maintenance
-- repair, running as a role the application is not a member of and already
-- gated by that membership.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_asset_review_authority() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    previous_status text := CASE WHEN tg_op = 'UPDATE' THEN old.status::text ELSE NULL END;
    actor           text;
  BEGIN
    IF app.current_user_id() IS NULL THEN
      RETURN new;
    END IF;

    IF new.status::text IS DISTINCT FROM previous_status THEN
      actor := coalesce(app.effective_role(), 'none');

      -- A decision on the work is the client's, and only a client admin's.
      -- A Zeeraa admin holds every other power in this product and
      -- deliberately not this one: a delivered figure Zeeraa could raise by
      -- itself is not a compliance record.
      IF new.status IN ('approved', 'changes_requested') AND actor <> 'client_admin' THEN
        RAISE EXCEPTION
          'Only a client admin may approve an asset or request changes (role: %)', actor
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      -- Submitting work for review, and publishing it afterwards, is Zeeraa's.
      IF new.status IN ('submitted', 'in_review', 'published')
         AND actor NOT IN ('zeeraa_admin', 'zeeraa_member') THEN
        RAISE EXCEPTION
          'Only Zeeraa may submit or publish an asset (role: %)', actor
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    -- The audit trail names whoever actually decided, not whoever the request
    -- claimed. Both columns are the record that settles a dispute; a row that
    -- credits somebody else is worse than no row.
    IF new.approved_by_user_id IS NOT NULL
       AND new.approved_by_user_id IS DISTINCT FROM
           (CASE WHEN tg_op = 'UPDATE' THEN old.approved_by_user_id ELSE NULL END)
       AND new.approved_by_user_id <> app.current_user_id() THEN
      RAISE EXCEPTION 'An approval must be recorded against the user who made it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF new.changes_requested_by_user_id IS NOT NULL
       AND new.changes_requested_by_user_id IS DISTINCT FROM
           (CASE WHEN tg_op = 'UPDATE' THEN old.changes_requested_by_user_id ELSE NULL END)
       AND new.changes_requested_by_user_id <> app.current_user_id() THEN
      RAISE EXCEPTION 'A rejection must be recorded against the user who made it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN new;
  END;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS assets_review_authority ON public.assets;--> statement-breakpoint

CREATE TRIGGER assets_review_authority
  BEFORE INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_asset_review_authority();--> statement-breakpoint
