-- ===========================================================================
-- The policy helpers, without a custom-parameter SET clause.
--
-- This is the same change `0002_force_rls.sql` now carries, restated as a
-- forward migration. Both files are needed and neither is redundant:
--
--   * a *fresh* database runs 0002, and 0002 had to stop carrying
--     `SET app.maintenance = 'on'` or it could not run on a managed Postgres
--     at all — only a true superuser may grant SET on a custom parameter, and
--     Neon has none (`permission denied for parameter app.maintenance`);
--   * an *already migrated* database never re-runs 0002, because drizzle's
--     ledger records the journal timestamp rather than a hash of the file, so
--     editing it is inert. Those databases get the change here.
--
-- Every statement is idempotent, so a fresh database applying both in sequence
-- lands in exactly the same place.
--
-- The guarantees are unchanged and are asserted in `test/force-rls.test.ts`:
-- FORCE still binds the owner on every table in `public`,
-- `maintenance_access` is still conditional on the flag, no role gains
-- BYPASSRLS, the helpers still return scalars rather than rows, and the mirror
-- they read is unreachable by every application role. Two mutations in
-- `scripts/mutation-test.ts` cover the mirror's own failure modes.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1b. The membership index.
--
-- Why a mirror rather than reading `memberships` directly: the helpers below
-- are called *from inside* the policies on `memberships`, and their owner is
-- bound by FORCE. Reading the table needs elevation, and the only elevation
-- this database can express is a session-level flag — which a policy helper
-- must not set, because the side effect would outlive the policy evaluation.
-- (`scripts/mutation-test.ts` designates exactly that as the mutation
-- `definer-elevates-in-body`.)
--
-- So the authorisation lookup moves to a table that needs no elevation:
--
--   * it lives in `app`, not `public`, so it is not tenant data and is outside
--     the sweep `assertRlsEnforced` runs over `public`;
--   * no application role holds any privilege on it, so `zeeraa_app`,
--     `zeeraa_auth` and `zeeraa_jobs_runner` cannot read or write it at all —
--     privileges are checked before policies, so this is the primary control;
--   * row level security is enabled with no permissive policy behind that, as
--     defence in depth;
--   * it is maintained synchronously, in the same transaction as the write to
--     `memberships`, so access is still answerable from `memberships` and
--     still revocable there.
-- --------------------------------------------------------------------------
create table if not exists app.membership_index (
  tenant_id uuid not null,
  user_id uuid not null,
  role public.role not null,
  primary key (tenant_id, user_id)
);
--> statement-breakpoint

alter table app.membership_index enable row level security;
--> statement-breakpoint

revoke all on app.membership_index from public;
--> statement-breakpoint

-- Keeps the mirror in step, row by row, in the writer's transaction. SECURITY
-- DEFINER because the writer may be `zeeraa_app` acting as a Zeeraa admin, and
-- that role must not hold a privilege on the index itself.
create or replace function app.sync_membership_index() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  begin
    if tg_op = 'DELETE' then
      delete from app.membership_index
        where tenant_id = old.tenant_id and user_id = old.user_id;
      return old;
    end if;

    -- A move between tenants leaves a stale key behind otherwise.
    if tg_op = 'UPDATE'
       and (old.tenant_id, old.user_id) is distinct from (new.tenant_id, new.user_id) then
      delete from app.membership_index
        where tenant_id = old.tenant_id and user_id = old.user_id;
    end if;

    insert into app.membership_index (tenant_id, user_id, role)
      values (new.tenant_id, new.user_id, new.role)
      on conflict (tenant_id, user_id) do update set role = excluded.role;
    return new;
  end;
  $$;
--> statement-breakpoint

drop trigger if exists memberships_index_sync on public.memberships;
--> statement-breakpoint

create trigger memberships_index_sync
  after insert or update or delete on public.memberships
  for each row execute function app.sync_membership_index();
--> statement-breakpoint

-- TRUNCATE is the one write a row-level trigger never sees, and it would
-- otherwise leave every membership in the mirror and nothing in the table.
create or replace function app.sync_membership_index_truncate() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$ begin delete from app.membership_index; return null; end; $$;
--> statement-breakpoint

drop trigger if exists memberships_index_truncate on public.memberships;
--> statement-breakpoint

create trigger memberships_index_truncate
  after truncate on public.memberships
  for each statement execute function app.sync_membership_index_truncate();
--> statement-breakpoint

-- Backfill. Opens the gate for the length of this statement only: a
-- session-level `set_config` on a custom parameter needs no grant, which is
-- exactly why it is usable here and not usable in a policy helper.
do $$
begin
  perform set_config('app.maintenance', 'on', true);
  insert into app.membership_index (tenant_id, user_id, role)
    select m.tenant_id, m.user_id, m.role from public.memberships m
    on conflict (tenant_id, user_id) do update set role = excluded.role;
  perform set_config('app.maintenance', 'off', true);
end $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 2. The SECURITY DEFINER helpers, reading the index.
--
-- Still SECURITY DEFINER, and still returning a boolean or a role name rather
-- than rows, so nothing leaks through them. What they no longer do is elevate:
-- `app.membership_index` carries no grant for any application role, so the
-- definer reads it without opening any gate. `set search_path` stays — it is a
-- recognised parameter, needs no grant, and pinning it is a requirement for a
-- SECURITY DEFINER function rather than an optimisation.
-- --------------------------------------------------------------------------

-- A Zeeraa admin may still work in any tenant, but only where a membership row
-- says so. Blanket access by role was a second, unauditable policy path: it
-- left no record of who could read which client, and nothing to revoke.
create or replace function app.has_tenant_access() returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from app.membership_index m
      where m.user_id = app.current_user_id()
        and m.tenant_id = app.current_tenant_id()
    )
  $$;
--> statement-breakpoint

create or replace function app.is_member_of(t uuid) returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from app.membership_index m
      where m.tenant_id = t and m.user_id = app.current_user_id()
    )
  $$;
--> statement-breakpoint

create or replace function app.effective_role() returns text
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select m.role::text from app.membership_index m
    where m.user_id = app.current_user_id()
      and m.tenant_id = app.current_tenant_id()
    limit 1
  $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The cardinality trigger, reading the index for the same reason.
-- --------------------------------------------------------------------------
create or replace function app.enforce_membership_cardinality() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    other_count integer;
  begin
    -- Rows are compared by tenant, not by id. On INSERT ... ON CONFLICT DO
    -- UPDATE the BEFORE INSERT trigger sees a NEW row carrying a freshly
    -- generated id rather than the existing row's, so an id comparison would
    -- mistake a re-run of the seed for a second membership.
    if new.role in ('client_admin', 'client_viewer') then
      -- The index, for the same reason the helpers use it. This is a BEFORE
      -- trigger, so the row being written is not in the mirror yet and this
      -- genuinely counts *other* memberships.
      select count(*) into other_count from app.membership_index m
        where m.user_id = new.user_id and m.tenant_id is distinct from new.tenant_id;
      if other_count > 0 then
        raise exception
          'User % holds a client role and may belong to exactly one tenant', new.user_id
          using errcode = 'check_violation';
      end if;
    else
      select count(*) into other_count from app.membership_index m
        where m.user_id = new.user_id
          and m.tenant_id is distinct from new.tenant_id
          and m.role in ('client_admin', 'client_viewer');
      if other_count > 0 then
        raise exception
          'User % already holds a client role and cannot also hold a Zeeraa role',
          new.user_id
          using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end;
  $$;
--> statement-breakpoint
