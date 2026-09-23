-- ===========================================================================
-- Account administration is a Zeeraa admin's alone, and a tenant always keeps
-- one.
--
-- **Why this is a security fix and not a tidy-up.** 0017 let a client admin
-- create accounts, grant client roles, remove client members and reset the
-- password of anybody sharing their tenant. "Anybody sharing their tenant"
-- includes the Zeeraa admins who hold a membership there — `users_admin_manage`
-- tested the actor's role and the target's tenant, never the target's role —
-- and a reset hands the new password back to whoever ran it. So a client admin
-- could reset a Zeeraa admin's password, sign in as them, and reach every other
-- client in the system. The account-admin suite asserted exactly that case as
-- passing ("reaches somebody in the tenant", resetting `fx.zeeraaAdmin`).
--
-- The client decision (23 September 2026): client admins have no People access
-- at all; only Zeeraa admins manage accounts. So every account policy now
-- requires `zeeraa_admin`, in the current tenant. The application checks the
-- same thing through `canManageUsers`, for a readable error — this is what
-- holds when somebody calls the database without the application.
--
-- **The last Zeeraa admin cannot be removed.** A tenant with no Zeeraa admin
-- is an engagement nobody can administer: no one can grant access, reset a
-- password or restore the admin, short of a maintenance session.
--
-- One trigger on `memberships`, AFTER each deleted or re-roled row, refusing
-- when the tenant is left with no Zeeraa admin. AFTER, and named to sort after
-- `memberships_index_sync`, so `app.membership_index` already reflects the row
-- and a statement removing two admins at once is judged row by row against
-- what remains. It sees every route: a direct DELETE, a raw maintenance
-- statement, and deleting the admin's *account*, which cascades here.
--
-- **Deleting the tenant itself is allowed**, and needs one more fact: whether
-- the tenant is going too. The trigger cannot read `tenants` — it is FORCE'd and
-- a definer holds no policy on it — and `pg_trigger_depth()` does not tell a
-- cascade apart (Postgres fires a cascade's AFTER triggers at depth 1). So
-- `app.tenant_index` mirrors tenant ids, like `app.membership_index` mirrors
-- memberships: no grant to any role, maintained by definer triggers, and
-- cleared by a BEFORE DELETE on `tenants`, which runs before the cascade. A
-- tenant absent from it is being deleted, and its people go with it.
--
-- The seed of the mirror reads `tenants`, so it runs inside the NO FORCE /
-- FORCE bracket `0016` explains: under FORCE the owner sees no rows.
-- ===========================================================================

DROP POLICY IF EXISTS users_admin_create ON public.users;--> statement-breakpoint
CREATE POLICY users_admin_create ON public.users
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

DROP POLICY IF EXISTS users_admin_manage ON public.users;--> statement-breakpoint
CREATE POLICY users_admin_manage ON public.users
  AS PERMISSIVE FOR UPDATE TO zeeraa_app
  USING (
    app.effective_role() = 'zeeraa_admin'
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()
    )
  )
  WITH CHECK (
    app.effective_role() = 'zeeraa_admin'
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS users_admin_resolve_unattached ON public.users;--> statement-breakpoint
CREATE POLICY users_admin_resolve_unattached ON public.users
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (
    app.effective_role() = 'zeeraa_admin'
    AND NOT app.holds_any_membership(users.id)
  );--> statement-breakpoint

DROP POLICY IF EXISTS memberships_admin_write ON public.memberships;--> statement-breakpoint
CREATE POLICY memberships_admin_write ON public.memberships
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.effective_role() = 'zeeraa_admin'
  );--> statement-breakpoint

DROP POLICY IF EXISTS memberships_admin_remove ON public.memberships;--> statement-breakpoint
CREATE POLICY memberships_admin_remove ON public.memberships
  AS PERMISSIVE FOR DELETE TO zeeraa_app
  USING (
    tenant_id = app.current_tenant_id()
    AND app.effective_role() = 'zeeraa_admin'
  );--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app.tenant_index (id uuid PRIMARY KEY);--> statement-breakpoint
ALTER TABLE app.tenant_index ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON app.tenant_index FROM public;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.sync_tenant_index() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  begin
    if tg_op = 'DELETE' then
      delete from app.tenant_index where id = old.id;
      return old;
    end if;
    insert into app.tenant_index (id) values (new.id) on conflict do nothing;
    return new;
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS tenants_index_insert ON public.tenants;--> statement-breakpoint
CREATE TRIGGER tenants_index_insert
  AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_index();--> statement-breakpoint
-- BEFORE, so the mirror row is gone before the cascade reaches memberships.
DROP TRIGGER IF EXISTS tenants_index_delete ON public.tenants;--> statement-breakpoint
CREATE TRIGGER tenants_index_delete
  BEFORE DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_index();--> statement-breakpoint

ALTER TABLE public.tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO app.tenant_index (id) SELECT id FROM public.tenants ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$
begin
  if (select count(*) from app.tenant_index) = 0 and exists (select 1 from app.membership_index) then
    raise exception 'tenant_index seeded empty while memberships exist; the NO FORCE bracket did not take';
  end if;
end $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.protect_last_zeeraa_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  begin
    if old.role <> 'zeeraa_admin' then
      return null;
    end if;
    if tg_op = 'UPDATE' and new.role = 'zeeraa_admin' and new.tenant_id = old.tenant_id then
      return null;
    end if;
    -- The tenant is being deleted; its people go with it.
    if not exists (select 1 from app.tenant_index t where t.id = old.tenant_id) then
      return null;
    end if;
    if not exists (
      select 1 from app.membership_index m
      where m.tenant_id = old.tenant_id and m.role = 'zeeraa_admin'
    ) then
      raise exception 'the last Zeeraa admin of a tenant cannot be removed'
        using errcode = 'P0001',
              hint = 'Grant another Zeeraa admin access to this tenant first.';
    end if;
    return null;
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS memberships_protect_last_zeeraa_admin ON public.memberships;--> statement-breakpoint
CREATE TRIGGER memberships_protect_last_zeeraa_admin
  AFTER DELETE OR UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app.protect_last_zeeraa_admin();--> statement-breakpoint

REVOKE ALL ON FUNCTION app.protect_last_zeeraa_admin() FROM public;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sync_tenant_index() FROM public;
