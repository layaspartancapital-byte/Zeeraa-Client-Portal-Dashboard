-- ===========================================================================
-- Contact fields for the Excel exports, and an audit entry per export
-- (30 October 2026, client decision).
--
-- 1. `crm_contacts`: a lead's or deal's name, email, phone, company and owner,
--    read from Salesforce by the sync. **Its own table, readable by a Zeeraa
--    admin or a client admin only.** Row level security cannot restrict
--    columns, so contact fields on `leads` would be readable by every member,
--    a viewer included, through any query that selects them; here the policy
--    is what holds, whatever the application asks for. Never SSN, date of
--    birth, bank or credit fields: the sync maps none and this table has no
--    column for them.
--
--    The CLAUDE.md policy set is narrowed on purpose, as on `user_activity`:
--    `tenant_isolation` admits the two admin roles rather than every member,
--    and there is no `tenant_admin_write` — nobody edits a contact from the
--    application; the sync writes them as the source has them.
--
-- 2. `audit_events` takes `export`: who exported what, for which range and
--    source, how many rows, and whether contact columns were in it — in
--    `detail`, never a contact value. Any member may record their own export,
--    and only their own (`own_export`). Still append-only: the trigger from
--    0040 refuses UPDATE, DELETE and TRUNCATE, and nobody holds those grants.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "crm_contacts" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	-- 'lead' | 'opportunity'
	"object" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"company" text,
	"owner_name" text,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("tenant_id", "object", "external_id"),
	CONSTRAINT "crm_contacts_object_check" CHECK ("object" IN ('lead', 'opportunity'))
);--> statement-breakpoint

GRANT SELECT ON public.crm_contacts TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.crm_contacts TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_contacts TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.crm_contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.crm_contacts;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.crm_contacts
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() IN ('zeeraa_admin', 'client_admin'));--> statement-breakpoint

DROP POLICY IF EXISTS job_tenant_isolation ON public.crm_contacts;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.crm_contacts
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

DROP POLICY IF EXISTS maintenance_access ON public.crm_contacts;--> statement-breakpoint
CREATE POLICY maintenance_access ON public.crm_contacts
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());--> statement-breakpoint

ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "detail" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_action_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_check" CHECK ("action" IN
  ('create_account', 'reset_password', 'grant_access', 'remove_access', 'sign_in', 'export'));--> statement-breakpoint

-- Your own export in the current tenant: you are its actor and its subject.
-- `tenant_admin_write` already refuses anything but an admin's account action,
-- and `own_sign_in` only a sign-in, so an export can be written no other way.
DROP POLICY IF EXISTS own_export ON public.audit_events;--> statement-breakpoint
CREATE POLICY own_export ON public.audit_events
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (action = 'export'
              AND tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND actor_user_id = app.current_user_id()
              AND subject_user_id = app.current_user_id());
