/**
 * Roles and what each may do.
 *
 * Zeeraa roles may hold membership in many tenants; client roles hold exactly
 * one. That asymmetry is enforced in the database (a trigger on `memberships`)
 * as well as here — this module is for UI affordances, not for security.
 */

export const ROLES = ['zeeraa_admin', 'zeeraa_member', 'client_admin', 'client_viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ZEERAA_ROLES: readonly Role[] = ['zeeraa_admin', 'zeeraa_member'];
export const CLIENT_ROLES: readonly Role[] = ['client_admin', 'client_viewer'];

export function isZeeraaRole(role: Role): boolean {
  return ZEERAA_ROLES.includes(role);
}

export function isClientRole(role: Role): boolean {
  return CLIENT_ROLES.includes(role);
}

/** Client roles never see the tenant switcher (§12, tenant identity). */
export function canSwitchTenant(role: Role): boolean {
  return isZeeraaRole(role);
}

export function canManageConnections(role: Role): boolean {
  return role === 'zeeraa_admin';
}

/**
 * Who may create accounts and reset passwords.
 *
 * Both admin roles, because there is no email in this product: nobody can
 * invite themselves, and a client waiting on Zeeraa to add their own new hire
 * is a support ticket rather than a security boundary. What a client admin
 * cannot do is reach another tenant or mint a Zeeraa role — see
 * `assignableRoles`, and the `memberships_admin_write` policy that actually
 * enforces it.
 */
export function canManageUsers(role: Role): boolean {
  return role === 'zeeraa_admin' || role === 'client_admin';
}

/**
 * The roles an admin may grant in the tenant they are administering.
 *
 * A client admin may grant client roles only. Granting `zeeraa_member` would
 * hand out a role that `canSwitchTenant` lets out of this tenant entirely, so
 * this is privilege escalation rather than a matter of taste, and the policy
 * repeats the restriction in SQL — this function decides what the form offers,
 * and is not what decides what the database accepts.
 */
export function assignableRoles(role: Role): readonly Role[] {
  if (role === 'zeeraa_admin') return ROLES;
  if (role === 'client_admin') return CLIENT_ROLES;
  return [];
}

/** "Sync now", admin screens, target reconciliation. */
export function canAdministerTenant(role: Role): boolean {
  return role === 'zeeraa_admin';
}

/** Sync failures are Zeeraa-only notifications (§11). */
export function canSeeOperationalAlerts(role: Role): boolean {
  return isZeeraaRole(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  zeeraa_admin: 'Zeeraa admin',
  zeeraa_member: 'Zeeraa team',
  client_admin: 'Client admin',
  client_viewer: 'Client viewer',
};
