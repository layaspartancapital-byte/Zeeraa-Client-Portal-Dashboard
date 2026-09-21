-- ===========================================================================
-- An account attached to no engagement can be granted access again.
--
-- The deadlock this fixes, reported 21 September 2026: remove somebody's
-- membership and they become unreachable. "Create an account" refuses, because
-- `users_email_key` is global and the address is taken. "Add an existing
-- account" refuses too, because its lookup runs under
-- `users_visible_within_tenant`, which admits a row only when it is the
-- caller's own or the target shares the current tenant. A user with no
-- membership anywhere shares nothing with anybody, so they are invisible to
-- every admin in the product while still occupying their address. There was no
-- way back through the application.
--
-- The SELECT policy is right for what it was written for — the roster, and
-- every avatar and byline — and it is not being loosened. A second permissive
-- policy adds exactly one case beside it: an admin may see an account that
-- belongs to **no tenant at all**.
--
-- What this deliberately does *not* do is let an admin see a user who belongs
-- to a different engagement. That remains invisible, to a Zeeraa admin as much
-- as to a client admin, because it is another client's roster. Moving such an
-- account is `scripts/grant-membership.ts`, which needs the maintenance
-- connection — the same gate as every other cross-tenant operation here.
--
-- **On what this exposes.** An admin can now discover that an address exists
-- while belonging to nothing. That is not a new disclosure: `users_email_key`
-- is global, so "Create an account" has always answered the same question by
-- refusing with a unique violation. What is new is that the answer is now
-- useful instead of a dead end.
--
-- Runs **before** the deploy: it only adds, and the policy is inert until code
-- looks for such a row.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Does this account belong to any tenant at all?
--
-- SECURITY DEFINER over `app.membership_index`, for the reason every helper
-- here is: as an invoker-rights function it would be subject to the
-- `memberships` policies, which show the caller only their own rows and the
-- current tenant's — so a user attached solely to *another* tenant would read
-- as unattached, and this policy would surface another engagement's roster.
-- The mirror has no grant to any application role and needs no elevation.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.holds_any_membership(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM app.membership_index m WHERE m.user_id = target)
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app.holds_any_membership(uuid) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.holds_any_membership(uuid) TO zeeraa_app;--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The one case the roster policy cannot cover.
--
-- Permissive, so it is OR-ed with `users_visible_within_tenant` rather than
-- narrowing it. Both halves are load-bearing: without the role test any signed
-- in user could enumerate unattached accounts, and without
-- `holds_any_membership` this would surface every user in the system.
-- --------------------------------------------------------------------------
CREATE POLICY users_admin_resolve_unattached ON public.users
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (
    app.effective_role() IN ('zeeraa_admin', 'client_admin')
    AND NOT app.holds_any_membership(users.id)
  );--> statement-breakpoint
