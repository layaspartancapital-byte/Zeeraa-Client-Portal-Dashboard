# Amendments to the build brief

The build brief is the governing specification for this platform. Where the
implementation departs from it, the departure is recorded here with the reason,
so that a reviewer comparing the two can tell a deliberate decision from a
mistake.

> The brief itself is not tracked in this repository — it has only ever been
> supplied out of band. Adding it under `docs/` would make these amendments
> checkable against their source, and is worth doing.

---

## §5 — Cross-tenant access for Zeeraa admins

**Superseded 17 September 2026.**

The brief said:

> `zeeraa_admin` may set any tenant; client roles only their own.

That wording was implemented literally in migration `0001_rls_policies.sql`:
`app.has_tenant_access()` returned true for anybody holding `zeeraa_admin` in
*any* tenant, whether or not they had a membership row in the tenant they were
asking about.

**The rule now:** a Zeeraa admin may work in a tenant only where a membership
row says so. There is no blanket grant by role. Implemented in
`0002_force_rls.sql`; the comment in `0001` describes what that migration did at
the time and is left as history.

### Why

Three reasons, in order of weight.

1. **It was unauditable.** "Who can read this client's funded volume?" had no
   answer in the database. The grant existed only as a role name on a row
   belonging to some other tenant, so there was nothing to list, nothing to
   review, and nothing to revoke short of demoting the person everywhere.

2. **It contradicted the brief's own stated goal.** §5 opens by requiring that
   cross-tenant reads be impossible at the database level, and the engagement
   promises the client that their data is never combined with another's. A
   standing grant to every tenant is the opposite of that, whoever holds it.

3. **It was a second policy path.** Every other read in the system resolves
   through one question — is there a membership row? — which is a single thing
   to test and a single thing to break. The admin clause was a parallel route
   with different semantics, and parallel routes are where isolation bugs live.

### What it costs

Adding a Zeeraa admin to a client is now a deliberate write rather than an
implicit consequence of their role. It happens through a seed or a
maintenance-gated statement, and it leaves a row. That is the intended
trade-off: joining a client engagement should be a recorded act.

### Covered by

`packages/db/test/tenant-isolation.test.ts`, "a Zeeraa admin holding one
membership" — six cases covering reads, writes, self-granted membership,
`effective_role()` and the tenant switcher.

The mutation `has-tenant-access-blanket-admin` in `scripts/mutation-test.ts`
restores the old clause and confirms those tests fail. If someone reinstates
it, CI says so.

---

## §12 — `FORCE ROW LEVEL SECURITY`

**Added 17 September 2026**, beyond what the brief required.

The brief required row level security and a non-superuser runtime role. The
implementation also forces it, so the policies bind the role that owns the
tables — a backfill script or a psql session is inside the model rather than
around it.

This required moving migrations and seeds off the superuser onto `zeeraa_owner`,
because a superuser bypasses row level security whatever is set. Without that
change FORCE would have been inert in local development and only real in
production, which is the worst of both.

Crossing tenants deliberately goes through `withMaintenance()`. See the README.
