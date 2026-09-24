-- The first-login product tour: whether somebody has finished (or skipped) it.
--
-- Per user, not per tenant and not per browser: a tour completed on a laptop
-- must not run again on a phone, and a Zeeraa admin with ten tenants has seen
-- the product once, not ten times. Versioned, so a revised tour can be shown
-- to people who finished an earlier one — a new version is a new row, and the
-- old row stays as the record that they saw it.
--
-- **Not on `users`.** `users_guard_own_account_row` refuses every self-update
-- outside the change-password flow, and it should keep doing so: widening the
-- account row's policy for a UI flag would be the first hole in it. A table of
-- its own carries its own policy and cannot touch an account.
--
-- **Not tenant-scoped.** It has no tenant_id, so the tenant policy set does not
-- apply. The one question it answers is "is this row mine", which is
-- `app.current_user_id()` — set transaction-locally by `withTenant` on every
-- request, like the tenant. A row cannot be read or written for anybody else,
-- and there is no DELETE grant: replaying the tour updates `completed_at`.

CREATE TABLE IF NOT EXISTS "product_tours" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"tour" text NOT NULL,
	"version" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_tours_pkey" PRIMARY KEY ("user_id", "tour", "version")
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.product_tours TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_tours TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.product_tours ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_tours FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY own_tours ON public.product_tours
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.product_tours
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());
