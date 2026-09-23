-- ===========================================================================
-- Members read their tenant's data; they do not write it. And nobody edits
-- their own account row except to change their password.
--
-- Two gaps from the 23 September 2026 audit, closed on the client's decision.
-- Neither was reachable through a screen; both were reachable by anything that
-- runs SQL as the application role in a tenant context — a code bug, an
-- injection — and the database is the layer meant to hold when the
-- application does not.
--
-- 1. **`tenant_isolation` was FOR ALL.** On 29 tables the application role's
--    only policy tested the tenant and never the role, and the role holds
--    INSERT, UPDATE and DELETE on all of them. So any member — a client viewer
--    included — could write their tenant's connections and credentials, its
--    field mapping, stage exclusions and corrections, funnel stages, metric
--    targets, engagement targets, reconciliation resolutions and every CRM and
--    ad row.
--
--    Now `tenant_isolation` is FOR SELECT: membership is what lets you read.
--    Writing needs `tenant_admin_write`, which adds `effective_role() =
--    'zeeraa_admin'`. The ingestion role is unaffected: it has its own
--    `job_tenant_isolation` policies, and is how every sync, webhook and
--    "Sync now" writes. No application path writes these tables as a member —
--    the web app writes `users` and `memberships` only — so nothing legitimate
--    loses anything.
--
--    The 29 are listed rather than discovered, so the exact set is reviewable
--    in this diff. A new tenant-scoped table follows the same pair.
--
-- 2. **`users_update_self` let a user write every granted column of their own
--    row** — their sign-in email, and `must_change_password` without a new
--    password, which undoes a forced change. It is replaced by
--    `users_change_own_password`, which admits the update only while the
--    change-password flow has marked its transaction
--    (`app.password_change = 'on'`, transaction-local, set by
--    `changeOwnPassword` after it has verified the current password), and a
--    trigger that holds the flow to exactly one change: a new hash, the
--    forced-change flag cleared, the timestamp. Any other self-edit — through
--    this policy or through an admin's — is refused, so a Zeeraa admin cannot
--    reset their own password from People either; they use change-password.
--
--    The marker is a convention the application keeps, not a secret: anything
--    already running SQL as the application could set it. What it buys is that
--    the only self-update the database accepts is the shape of a password
--    change, so it cannot be used to change an email or skip a forced reset.
-- ===========================================================================

DO $$
declare
  t text;
  tables text[] := array[
    'ad_accounts', 'ad_clicks', 'ai_visibility', 'attribution', 'baselines',
    'blocked_dependencies', 'calls', 'campaigns', 'click_ingest_days',
    'connections', 'daily_metrics', 'data_sources', 'engagement_targets',
    'funnel_stages', 'ga4_metrics', 'leads', 'milestones', 'notifications',
    'opportunities', 'opportunity_click_ids', 'organic_metrics',
    'reconciliation_items', 'search_console_metrics', 'stage_events',
    'submissions', 'sync_runs', 'tenant_config', 'tenant_metrics',
    'webhook_deliveries'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($f$
      create policy tenant_isolation on public.%I
        as permissive for select to zeeraa_app
        using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
    $f$, t);
    execute format('drop policy if exists tenant_admin_write on public.%I', t);
    execute format($f$
      create policy tenant_admin_write on public.%I
        as permissive for all to zeeraa_app
        using (tenant_id = app.current_tenant_id() and app.has_tenant_access()
               and app.effective_role() = 'zeeraa_admin')
        with check (tenant_id = app.current_tenant_id() and app.has_tenant_access()
                    and app.effective_role() = 'zeeraa_admin')
    $f$, t);
  end loop;

  -- The whole point is that no member-grade write policy survives anywhere.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and policyname = 'tenant_isolation' and cmd <> 'SELECT'
  ) then
    raise exception 'a tenant_isolation policy still admits writes';
  end if;
end $$;--> statement-breakpoint

DROP POLICY IF EXISTS users_update_self ON public.users;--> statement-breakpoint
CREATE POLICY users_change_own_password ON public.users
  AS PERMISSIVE FOR UPDATE TO zeeraa_app
  USING (id = app.current_user_id() AND current_setting('app.password_change', true) = 'on')
  WITH CHECK (id = app.current_user_id() AND current_setting('app.password_change', true) = 'on');--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_own_account_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  begin
    -- Not the signed-in person's own row (or no person in context: sign-in,
    -- maintenance, migrations): nothing to guard here.
    if app.current_user_id() is null or new.id is distinct from app.current_user_id() then
      return new;
    end if;
    if coalesce(current_setting('app.password_change', true), '') <> 'on' then
      raise exception 'an account row is not edited directly; change a password through the change-password flow'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id
       or new.email is distinct from old.email
       or new.name is distinct from old.name
       or new.title is distinct from old.title
       or new.avatar_url is distinct from old.avatar_url
       or new.created_at is distinct from old.created_at
       or new.password_hash is not distinct from old.password_hash
       or new.password_hash is null
       or new.must_change_password
    then
      raise exception 'the change-password flow sets a new password and nothing else'
        using errcode = '42501';
    end if;
    return new;
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS users_guard_own_account_row ON public.users;--> statement-breakpoint
CREATE TRIGGER users_guard_own_account_row
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION app.guard_own_account_row();
