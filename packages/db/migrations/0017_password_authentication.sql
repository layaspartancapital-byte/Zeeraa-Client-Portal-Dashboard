-- ===========================================================================
-- Password authentication, and the admin path that creates an account.
--
-- Sign-in was a magic link (Resend) or Google OAuth. Neither is wanted: there
-- is no email in this product now, and nobody registers themselves. An admin
-- creates the account, sets an initial password, tells the person out of band,
-- and the person is made to replace it on first sign-in.
--
-- **This migration runs before the deploy.** For an addition the schema leads:
-- the code that reads `password_hash` cannot ship before the column exists. It
-- is written so that the old deploy keeps working while it is applied — the new
-- columns are nullable or defaulted, and the two tables it drops are Auth.js's
-- OAuth and magic-link tables, which the old code only touches on a sign-in
-- attempt. See `docs/brief-amendments.md`, "§11 — sign-in is a password".
--
-- What does NOT change: access is still a membership row. A user row with no
-- membership is an account that can sign in and see `/no-access`, exactly as an
-- unrecognised magic-link address did.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- The credential.
-- --------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint

-- Null `password_hash` means the account cannot sign in. Every existing row is
-- in that state after this migration, deliberately: the four seeded accounts
-- authenticated by email and have no password, so an admin sets one. There is
-- no default password and no grace period.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_updated_at" timestamp with time zone;--> statement-breakpoint

-- `email_verified` was Auth.js's record that a magic link had been opened.
-- Nothing verifies an address any more because nothing sends to one.
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified";--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The Auth.js tables that have no purpose left.
--
-- `accounts` held OAuth provider links; `verification_tokens` held magic-link
-- tokens. `sessions` stays and becomes the session store proper — a session is
-- a row rather than a signed token, so ending one takes effect on the next
-- request rather than whenever a token would have expired.
-- --------------------------------------------------------------------------
DROP TABLE IF EXISTS "accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "verification_tokens";--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint

-- Ending every session a user holds is one statement on a reset, and this is
-- the index it uses. Without it that is a sequential scan of every live
-- session, on the path an admin takes when they believe a password is
-- compromised — the one time latency is least welcome.
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Creating an account, from the application role.
--
-- `users` already granted INSERT to zeeraa_app and had no INSERT policy, so
-- under FORCE the insert was denied — there was no way to create a user from
-- the application, because there was no feature that did.
--
-- The check is on the *actor*, not on the row, because a new user row has no
-- membership yet and so nothing tenant-scoped to test. That is the model the
-- brief asks for: creating an account and granting it access are two acts. The
-- tenant half is enforced one statement later, on the membership insert, and
-- an account with no membership reaches `/no-access` and nothing else.
--
-- `app.effective_role()` is the current tenant's role for the current user, so
-- an admin of tenant A creating an account while working in tenant A is the
-- only shape this permits. It is SECURITY DEFINER over `app.membership_index`
-- and needs no elevation.
-- --------------------------------------------------------------------------
CREATE POLICY users_admin_create ON public.users
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (app.effective_role() IN ('zeeraa_admin', 'client_admin'));--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Resetting somebody else's password.
--
-- Scoped to people who share the tenant the admin is working in. A client admin
-- cannot reach a user outside their own engagement, and a Zeeraa admin cannot
-- reach one outside the tenant they currently have open — crossing tenants
-- stays an explicit act with a different role, as it is everywhere else here.
--
-- USING and WITH CHECK are the same expression on purpose: without the WITH
-- CHECK an admin could move a row out of their own reach, and without USING
-- they could not select it to update in the first place.
--
-- **The tenant clause here is a second lock, not the only one.** Removing it
-- changes nothing observable: `users_visible_within_tenant` already refuses to
-- surface a user from another tenant, so the row cannot be found to update and
-- the statement reports `UPDATE 0` — verified against a mutated schema rather
-- than assumed. It is written out anyway because this policy should be correct
-- read on its own, and because a future change to the SELECT policy must not
-- silently widen what a password reset can reach. The mutation that covers the
-- reachable control is `users-visible-to-all`.
-- --------------------------------------------------------------------------
CREATE POLICY users_admin_manage ON public.users
  AS PERMISSIVE FOR UPDATE TO zeeraa_app
  USING (
    app.effective_role() IN ('zeeraa_admin', 'client_admin')
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()
    )
  )
  WITH CHECK (
    app.effective_role() IN ('zeeraa_admin', 'client_admin')
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()
    )
  );--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Granting access: client admins, in their own tenant, to client roles only.
--
-- `memberships_admin_write` required `zeeraa_admin`, so a client admin could
-- not add anybody. That is now half the feature, so it is widened — but only
-- as far as the roles a client admin is allowed to hand out.
--
-- **`AND role IN ('client_admin','client_viewer')` is the whole security of
-- this change.** `zeeraa_member` and `zeeraa_admin` are the roles
-- `canSwitchTenant` lets out of the current tenant; a client admin who could
-- grant one could mint an account that reads every other client in the system.
-- The cardinality trigger is a second, independent limit: a client role may
-- hold exactly one tenant, so a granted client role cannot be spread.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS memberships_admin_write ON public.memberships;--> statement-breakpoint
CREATE POLICY memberships_admin_write ON public.memberships
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.effective_role() = 'zeeraa_admin'
      OR (
        app.effective_role() = 'client_admin'
        AND role IN ('client_admin', 'client_viewer')
      )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS memberships_admin_remove ON public.memberships;--> statement-breakpoint
CREATE POLICY memberships_admin_remove ON public.memberships
  AS PERMISSIVE FOR DELETE TO zeeraa_app
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.effective_role() = 'zeeraa_admin'
      OR (
        app.effective_role() = 'client_admin'
        AND role IN ('client_admin', 'client_viewer')
      )
    )
  );--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Closing a self-escalation that predates this work.
--
-- `memberships_update_own` exists so somebody can change their own
-- notification preferences, and its comment says so. What it actually allowed
-- was an UPDATE of any column of your own membership row — including `role`.
-- `app.effective_role()` reads `app.membership_index`, which is synchronously
-- maintained from this table, so `UPDATE memberships SET role='zeeraa_admin'
-- WHERE user_id = me` would have made the change take effect immediately.
--
-- Row level security cannot restrict columns, so the column grant does it. No
-- application path writes any other column of this table — an admin grant is an
-- INSERT and a revocation is a DELETE — so nothing legitimate loses anything.
--
-- It was not reachable before today: nothing in the application updated
-- `memberships` at all. It is being closed now because this migration makes
-- the table writable from the application for the first time, and a latent hole
-- next to a new write path is not one to leave for later.
-- --------------------------------------------------------------------------
REVOKE UPDATE ON public.memberships FROM zeeraa_app;--> statement-breakpoint
GRANT UPDATE (email_preference, slack_enabled) ON public.memberships TO zeeraa_app;--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The auth role loses the two dropped tables and keeps the rest.
--
-- It still exists and still matters: sign-in happens before any tenant context
-- exists, so the password check and the session lookup cannot run under
-- policies that ask which tenant is current. Its reach is identity only.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS users_auth_adapter ON public.users;--> statement-breakpoint
CREATE POLICY users_auth_signin ON public.users
  AS PERMISSIVE FOR ALL TO zeeraa_auth USING (true) WITH CHECK (true);--> statement-breakpoint
