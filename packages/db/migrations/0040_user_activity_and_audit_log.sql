-- ===========================================================================
-- Two tables for the People screen (25 September 2026).
--
-- 1. `user_activity`: when somebody was last seen in a tenant, and on which
--    page. One row per (tenant, user), upserted by the person themselves at
--    most once a minute — the write rides on a page view that already woke the
--    database, and the throttle means a busy session costs one statement a
--    minute rather than one per click.
--
--    Read by a Zeeraa admin only. The CLAUDE.md policy set is narrowed on
--    purpose: `tenant_isolation` admits the zeeraa_admin role rather than every
--    member, because when a colleague was last online is not a client-facing
--    fact, and there is no `tenant_admin_write` — nobody writes another
--    person's activity, an admin included. `own_activity` is the only writer.
--
-- 2. `audit_events`: who did what to which account, and every sign-in.
--    **Append-only, for every role**, the shape `baseline_snapshots` (0032)
--    set: no UPDATE or DELETE grant to anybody, and a trigger that refuses
--    both even to a role no policy binds. The one deletion allowed is the
--    whole tenant's, told apart through `app.tenant_index`.
--
--    No foreign key to `users`: the record has to outlive the account it is
--    about (`delete-account.ts`), and a cascade would be a deletion the
--    trigger refuses. The address and name are copied onto the row for the
--    same reason — the log reads the same after the account is gone.
--
--    Sign-ins are tenant rows too: one per tenant the person holds at the
--    moment they sign in, so each tenant's log is its own and no screen reads
--    a sign-in from outside the current tenant. A sign-in by an account with
--    no membership is therefore not recorded; it reaches `/no-access` and
--    nothing else.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "user_activity" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The pathname only, never the query string.
	"last_path" text NOT NULL,
	CONSTRAINT "user_activity_pkey" PRIMARY KEY ("tenant_id", "user_id"),
	CONSTRAINT "user_activity_path_length" CHECK (char_length("last_path") <= 300)
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.user_activity TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_activity TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.user_activity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.user_activity FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.user_activity
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

-- Your own row in the current tenant. FOR ALL rather than INSERT and UPDATE,
-- because INSERT ... ON CONFLICT DO UPDATE applies the SELECT policy to the
-- existing row; without it a client's upsert would fail on its second visit.
CREATE POLICY own_activity ON public.user_activity
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND user_id = app.current_user_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.user_activity
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- create_account | reset_password | grant_access | remove_access | sign_in
	"action" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_email" text NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"subject_email" text NOT NULL,
	-- The role granted, for create_account and grant_access; the role held,
	-- for remove_access.
	"role" text,
	CONSTRAINT "audit_events_action_check" CHECK ("action" IN
	  ('create_account', 'reset_password', 'grant_access', 'remove_access', 'sign_in'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_events_tenant_time"
  ON "audit_events" USING btree ("tenant_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_sign_in"
  ON "audit_events" USING btree ("tenant_id", "subject_user_id", "occurred_at" DESC)
  WHERE "action" = 'sign_in';--> statement-breakpoint

GRANT SELECT, INSERT ON public.audit_events TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.audit_events TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Zeeraa admins only, as on user_activity: this is Zeeraa's record.
CREATE POLICY tenant_isolation ON public.audit_events
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

-- An account action is written by the Zeeraa admin who took it, in the same
-- transaction, and names them: the actor cannot be somebody else.
CREATE POLICY tenant_admin_write ON public.audit_events
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (action <> 'sign_in'
              AND tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin'
              AND actor_user_id = app.current_user_id());--> statement-breakpoint

-- A sign-in is written by the person signing in, with only a user in context
-- (`withUserOnly`), into each tenant they hold. Their own, and nobody else's.
CREATE POLICY own_sign_in ON public.audit_events
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (action = 'sign_in'
              AND actor_user_id = app.current_user_id()
              AND subject_user_id = app.current_user_id()
              AND app.is_member_of(tenant_id));--> statement-breakpoint

CREATE POLICY maintenance_access ON public.audit_events
  AS PERMISSIVE FOR SELECT TO zeeraa_maintenance
  USING (app.is_maintenance());--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_events_append_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  begin
    -- The whole tenant is going: its tenant_index row is removed BEFORE the
    -- delete, so the cascade finds it gone and passes.
    if tg_op = 'DELETE' and not exists (select 1 from app.tenant_index t where t.id = old.tenant_id) then
      return old;
    end if;
    raise exception 'the audit log is not edited or deleted'
      using errcode = '42501';
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_append_only ON public.audit_events;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();--> statement-breakpoint

-- TRUNCATE fires no row trigger, and the owner holds the privilege by
-- ownership. A statement trigger refuses it too. Invoker rights: it reads
-- nothing, so it needs no owner's privileges.
CREATE OR REPLACE FUNCTION app.audit_events_no_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  begin
    raise exception 'the audit log is not truncated' using errcode = '42501';
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_no_truncate ON public.audit_events;--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_no_truncate();--> statement-breakpoint

REVOKE ALL ON FUNCTION app.audit_events_append_only() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_events_no_truncate() FROM public;
