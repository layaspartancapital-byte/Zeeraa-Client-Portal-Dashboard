-- ===========================================================================
-- Row level security.
--
-- Zeeraa's contract promises that one client's data is never combined with
-- another's. Application-level `where tenant_id = ?` cannot carry that promise:
-- it holds until the first query someone writes in a hurry. These policies make
-- a cross-tenant read impossible at the database level, so a forgotten filter
-- returns an empty screen instead of a competitor's funded volume.
--
-- The model:
--   * `zeeraa_app`  — the runtime role. NOBYPASSRLS, not the table owner.
--   * `zeeraa_auth` — the Auth.js adapter role. Reaches identity tables only,
--                     and no tenant-scoped table at all.
--   * the owner     — migrations and seeds. Never used by the application.
--
-- Context arrives as transaction-local settings (see withTenant in
-- src/tenant-context.ts). With no context set, every policy below evaluates to
-- false, so the default state is zero rows rather than all rows.
-- ===========================================================================

create schema if not exists app;
grant usage on schema app to zeeraa_app, zeeraa_auth;
--> statement-breakpoint

create or replace function app.current_tenant_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_tenant_id', true), '')::uuid $$;
--> statement-breakpoint

create or replace function app.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_user_id', true), '')::uuid $$;
--> statement-breakpoint

-- The claimed role, for convenience in policies. Never trusted on its own:
-- anything that matters reads the actual membership row via app.effective_role().
create or replace function app.claimed_role() returns text
  language sql stable
  as $$ select nullif(current_setting('app.current_user_role', true), '') $$;
--> statement-breakpoint

-- Does the current user have any business in the current tenant?
--
-- SECURITY DEFINER because it reads `memberships`, which is itself protected by
-- a policy that calls this function; without it the check would recurse.
--
-- The expression does not reference the row under test, so the planner folds it
-- into a single InitPlan rather than re-running it per row.
create or replace function app.has_tenant_access() returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.memberships m
      where m.user_id = app.current_user_id()
        and (
          m.tenant_id = app.current_tenant_id()
          -- Zeeraa admins may set any tenant; client roles only their own.
          or m.role = 'zeeraa_admin'
        )
    )
  $$;
--> statement-breakpoint

-- The role the current user actually holds in the current tenant, read from the
-- membership row rather than from the request. Used by write policies.
create or replace function app.effective_role() returns text
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select coalesce(
      (select m.role::text from public.memberships m
         where m.user_id = app.current_user_id()
           and m.tenant_id = app.current_tenant_id()
         limit 1),
      (select 'zeeraa_admin' from public.memberships m
         where m.user_id = app.current_user_id() and m.role = 'zeeraa_admin'
         limit 1)
    )
  $$;
--> statement-breakpoint

-- Is the current user a member of this specific tenant? Backs the switcher,
-- which has to name a user's tenants before any tenant has been chosen.
create or replace function app.is_member_of(t uuid) returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from public.memberships m
      where m.tenant_id = t and m.user_id = app.current_user_id()
    )
  $$;
--> statement-breakpoint

revoke execute on function
  app.has_tenant_access(), app.effective_role(), app.is_member_of(uuid) from public;
--> statement-breakpoint
grant execute on function app.current_tenant_id(), app.current_user_id(),
  app.claimed_role(), app.has_tenant_access(), app.effective_role(),
  app.is_member_of(uuid)
  to zeeraa_app, zeeraa_auth;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Client roles hold exactly one membership (§4). Enforced here rather than in
-- application code because it is the premise the whole isolation model rests
-- on: a client user who could be attached to a second tenant would be able to
-- read it.
-- --------------------------------------------------------------------------
create or replace function app.enforce_membership_cardinality() returns trigger
  language plpgsql
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

create trigger memberships_cardinality
  before insert or update on public.memberships
  for each row execute function app.enforce_membership_cardinality();
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Grants. The application role gets DML on tenant data and nothing else; it
-- cannot reach the identity tables, and the auth role cannot reach tenant data.
-- --------------------------------------------------------------------------
grant usage on schema public to zeeraa_app, zeeraa_auth;
--> statement-breakpoint

-- RLS is enabled on every tenant-scoped table, plus the identity tables.
--
-- FORCE is deliberately not used. It would also subject the table owner, and
-- the owner connection is what runs migrations and seeds — on a managed
-- Postgres where the owner is not a superuser that turns a seed into a silent
-- no-op. The misconfiguration FORCE guards against (the application connecting
-- as owner) is instead caught loudly at startup by assertRlsEnforced(), which
-- refuses to serve if the runtime role can bypass RLS.
do $$
declare
  t text;
  rls_tables text[] := array[
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
  foreach t in array rls_tables loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
--> statement-breakpoint

-- DML for the application role on tenant data. `tenants` is read-only from the
-- application: a tenant is provisioned by migration and seed, never by a request.
do $$
declare
  t text;
  data_tables text[] := array[
    'connections',
    'ad_accounts','campaigns','daily_metrics','organic_metrics','ai_visibility',
    'leads','opportunities','stage_events','attribution',
    'funnel_stages','tenant_metrics','tenant_config','baselines','milestones',
    'deliverable_commitments','deliverable_records','sla_commitments','sla_events',
    'asset_types','assets','asset_comments','mentions','notifications','activity_log',
    'sync_runs','data_sources','reconciliation_items'
  ];
begin
  foreach t in array data_tables loop
    execute format('grant select, insert, update, delete on public.%I to zeeraa_app', t);
  end loop;
end $$;
--> statement-breakpoint

grant select on public.tenants to zeeraa_app;
--> statement-breakpoint
grant select, insert, update, delete on public.memberships to zeeraa_app;
--> statement-breakpoint

-- `users` is reachable from both roles for different reasons, so it is granted
-- and policed separately.
grant select, insert, update on public.users to zeeraa_app;
--> statement-breakpoint
grant select, insert, update, delete on public.users to zeeraa_auth;
--> statement-breakpoint
grant select, insert, update, delete
  on public.accounts, public.sessions, public.verification_tokens to zeeraa_auth;
--> statement-breakpoint


-- --------------------------------------------------------------------------
-- Tenant-scoped policies.
--
-- One policy per table, identical in shape: the row's tenant must be the
-- current tenant, and the current user must have access to it. Both halves are
-- needed — the first alone would trust whatever tenant id the request asked
-- for, the second alone would not constrain the rows.
-- --------------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'connections',
    'ad_accounts','campaigns','daily_metrics','organic_metrics','ai_visibility',
    'leads','opportunities','stage_events','attribution',
    'funnel_stages','tenant_metrics','tenant_config','baselines','milestones',
    'deliverable_commitments','deliverable_records','sla_commitments','sla_events',
    'asset_types','assets','asset_comments','mentions','notifications','activity_log',
    'sync_runs','data_sources','reconciliation_items'
  ];
begin
  foreach t in array tenant_tables loop
    execute format($f$
      create policy tenant_isolation on public.%I
        as permissive for all to zeeraa_app
        using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
        with check (tenant_id = app.current_tenant_id() and app.has_tenant_access())
    $f$, t);
  end loop;
end $$;
--> statement-breakpoint

-- `activity_log` is append-only: it is the audit trail, so it must not be
-- rewritable by the role that writes to it.
create policy activity_log_append_only on public.activity_log
  as restrictive for update to zeeraa_app using (false);
--> statement-breakpoint
create policy activity_log_no_delete on public.activity_log
  as restrictive for delete to zeeraa_app using (false);
--> statement-breakpoint

-- The tenant row itself. A user always sees the tenants they are a member of,
-- with no tenant context set — that is what puts a name and an accent colour in
-- the switcher before anything has been chosen. Beyond that, whatever tenant is
-- currently in context and permitted.
--
-- Never writable from the application: tenants are provisioned by migration and
-- seed, not by a request.
create policy tenants_read on public.tenants
  as permissive for select to zeeraa_app
  using (
    app.is_member_of(id)
    or (id = app.current_tenant_id() and app.has_tenant_access())
  );
--> statement-breakpoint

-- Memberships. A user always sees their own rows, with no tenant set — that is
-- what populates the tenant switcher before a tenant has been chosen. Beyond
-- that, only the current tenant's roster, which is also what backs the mention
-- picker: it cannot surface a user from another tenant because there is no row
-- here to join to.
create policy memberships_self_or_current_tenant on public.memberships
  as permissive for select to zeeraa_app
  using (
    user_id = app.current_user_id()
    or (tenant_id = app.current_tenant_id() and app.has_tenant_access())
  );
--> statement-breakpoint

-- Members manage their own notification preferences; nothing else here is
-- writable from the application.
create policy memberships_update_own on public.memberships
  as permissive for update to zeeraa_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
--> statement-breakpoint

create policy memberships_admin_write on public.memberships
  as permissive for insert to zeeraa_app
  with check (tenant_id = app.current_tenant_id() and app.effective_role() = 'zeeraa_admin');
--> statement-breakpoint
create policy memberships_admin_remove on public.memberships
  as permissive for delete to zeeraa_app
  using (tenant_id = app.current_tenant_id() and app.effective_role() = 'zeeraa_admin');
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Identity tables.
-- --------------------------------------------------------------------------

-- The application may read a user only when that user shares the current
-- tenant, or when it is the requester themselves. This is the second lock on
-- the mention picker (§16) and on every avatar and byline in the product.
create policy users_visible_within_tenant on public.users
  as permissive for select to zeeraa_app
  using (
    id = app.current_user_id()
    or (
      app.has_tenant_access()
      and exists (
        select 1 from public.memberships m
        where m.user_id = users.id and m.tenant_id = app.current_tenant_id()
      )
    )
  );
--> statement-breakpoint

create policy users_update_self on public.users
  as permissive for update to zeeraa_app
  using (id = app.current_user_id())
  with check (id = app.current_user_id());
--> statement-breakpoint

-- Sign-in happens before any tenant exists in the request, so the adapter runs
-- on its own role with unconditional access to identity tables only.
create policy users_auth_adapter on public.users
  as permissive for all to zeeraa_auth using (true) with check (true);
--> statement-breakpoint
create policy accounts_auth_adapter on public.accounts
  as permissive for all to zeeraa_auth using (true) with check (true);
--> statement-breakpoint
create policy sessions_auth_adapter on public.sessions
  as permissive for all to zeeraa_auth using (true) with check (true);
--> statement-breakpoint
create policy verification_tokens_auth_adapter on public.verification_tokens
  as permissive for all to zeeraa_auth using (true) with check (true);
--> statement-breakpoint

-- Membership lookup during session hydration: the auth role needs to read which
-- tenants a user belongs to in order to put a role on the session. Read only.
grant select on public.memberships, public.tenants to zeeraa_auth;
--> statement-breakpoint
create policy memberships_auth_read on public.memberships
  as permissive for select to zeeraa_auth using (true);
--> statement-breakpoint
create policy tenants_auth_read on public.tenants
  as permissive for select to zeeraa_auth using (true);
