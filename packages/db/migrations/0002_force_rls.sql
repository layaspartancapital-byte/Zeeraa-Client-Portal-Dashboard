-- ===========================================================================
-- Hardening pass before the Salesforce work.
--
-- Four changes, each closing a path the first cut left open:
--
--   1. FORCE ROW LEVEL SECURITY, so the table owner is bound by the same
--      policies as the application — a backfill script or a psql session is
--      no longer outside the model.
--   2. An explicit maintenance gate, because (1) would otherwise make seeds
--      and backfills impossible rather than merely deliberate.
--   3. The Zeeraa admin cross-tenant path now requires a real membership row
--      per tenant. It previously granted every tenant to anyone holding the
--      role anywhere, with no row to audit.
--   4. The membership cardinality trigger becomes SECURITY DEFINER. As an
--      invoker-rights function it read `memberships` under the caller's own
--      policies, so it could not see the row it was meant to find — a Zeeraa
--      admin in tenant A could attach one of tenant B's client users to
--      tenant A, giving that user two memberships and a read on both.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. The maintenance gate.
--
-- `zeeraa_maintenance` is a NOLOGIN role granted to whoever owns the tables,
-- and to `zeeraa_maint` for backfills and psql sessions. Membership alone
-- grants nothing: the policies below also require `app.maintenance` to be set
-- on, so an ordinary session by the owner still sees no tenant rows. Turning
-- it on is a deliberate act, per transaction, and it is greppable.
--
-- `zeeraa_app` is not a member, so setting the GUC from the application buys
-- nothing — the policy does not apply to it at all.
-- --------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'zeeraa_maintenance') then
    create role zeeraa_maintenance nologin;
  end if;
end $$;
--> statement-breakpoint

create or replace function app.is_maintenance() returns boolean
  language sql stable
  as $$ select coalesce(current_setting('app.maintenance', true), 'off') = 'on' $$;
--> statement-breakpoint

grant execute on function app.is_maintenance() to public;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 2. The SECURITY DEFINER helpers now run with the maintenance flag set.
--
-- These functions are owned by the role that owns the tables, and FORCE now
-- binds that role too — so without this they would read zero rows from
-- `memberships` and every policy in the schema would evaluate to false. The
-- function-level SET scopes the flag to the function body and reverts on exit.
-- Each returns a boolean or a role name, never rows, so nothing leaks through.
-- --------------------------------------------------------------------------

-- A Zeeraa admin may still work in any tenant, but only where a membership row
-- says so. Blanket access by role was a second, unauditable policy path: it
-- left no record of who could read which client, and nothing to revoke.
create or replace function app.has_tenant_access() returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  set app.maintenance = 'on'
  as $$
    select exists (
      select 1 from public.memberships m
      where m.user_id = app.current_user_id()
        and m.tenant_id = app.current_tenant_id()
    )
  $$;
--> statement-breakpoint

create or replace function app.is_member_of(t uuid) returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  set app.maintenance = 'on'
  as $$
    select exists (
      select 1 from public.memberships m
      where m.tenant_id = t and m.user_id = app.current_user_id()
    )
  $$;
--> statement-breakpoint

create or replace function app.effective_role() returns text
  language sql stable security definer
  set search_path = public, pg_temp
  set app.maintenance = 'on'
  as $$
    select m.role::text from public.memberships m
    where m.user_id = app.current_user_id()
      and m.tenant_id = app.current_tenant_id()
    limit 1
  $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 3. The cardinality trigger, with the rights it always needed.
--
-- The rule it enforces is a premise of the isolation model, so it has to see
-- every membership a user holds — including ones in tenants the caller cannot
-- read. Running as invoker it saw only the caller's own tenant, which made it
-- trivially bypassable from the application.
-- --------------------------------------------------------------------------
create or replace function app.enforce_membership_cardinality() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  set app.maintenance = 'on'
  as $$
  declare
    other_count integer;
  begin
    -- Rows are compared by tenant, not by id. On INSERT ... ON CONFLICT DO
    -- UPDATE the BEFORE INSERT trigger sees a NEW row carrying a freshly
    -- generated id rather than the existing row's, so an id comparison would
    -- mistake a re-run of the seed for a second membership.
    if new.role in ('client_admin', 'client_viewer') then
      select count(*) into other_count from public.memberships m
        where m.user_id = new.user_id and m.tenant_id is distinct from new.tenant_id;
      if other_count > 0 then
        raise exception
          'User % holds a client role and may belong to exactly one tenant', new.user_id
          using errcode = 'check_violation';
      end if;
    else
      select count(*) into other_count from public.memberships m
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

-- --------------------------------------------------------------------------
-- 4. FORCE, and the maintenance policy that keeps the door usable.
--
-- Note what FORCE cannot do: a superuser bypasses row level security
-- regardless. On a managed Postgres the owner is not a superuser and this
-- binds; on a local Docker image where the owner is `postgres`, it does not.
-- That is why migrations and seeds connect as `zeeraa_owner` rather than as
-- `postgres` — so local development exercises the same constraint production
-- does, instead of passing for a reason that will not hold.
-- --------------------------------------------------------------------------
do $$
declare
  t text;
  all_tables text[] := array[
    'tenants','memberships','connections',
    'ad_accounts','campaigns','daily_metrics','organic_metrics','ai_visibility',
    'leads','opportunities','stage_events','attribution',
    'funnel_stages','tenant_metrics','tenant_config','baselines','milestones',
    'deliverable_commitments','deliverable_records','sla_commitments','sla_events',
    'asset_types','assets','asset_comments','mentions','notifications','activity_log',
    'sync_runs','data_sources','reconciliation_items',
    'users','accounts','sessions','verification_tokens'
  ];
begin
  foreach t in array all_tables loop
    execute format('alter table public.%I force row level security', t);
    execute format($f$
      create policy maintenance_access on public.%I
        as permissive for all to zeeraa_maintenance
        using (app.is_maintenance())
        with check (app.is_maintenance())
    $f$, t);
    execute format(
      'grant select, insert, update, delete on public.%I to zeeraa_maintenance', t);
  end loop;
end $$;
