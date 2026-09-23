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
 * Who may open People: create accounts, grant and remove access, reset
 * passwords. **Zeeraa admins only** (client decision, 23 September 2026).
 *
 * It was both admin roles, and that was a privilege escalation rather than a
 * convenience: a client admin could reset the password of a Zeeraa admin who
 * held a membership in their tenant, be handed the new password, and sign in
 * as somebody who can reach every client. Migration 0027 makes the same rule
 * the database's; this function is the readable half.
 */
export function canManageUsers(role: Role): boolean {
  return role === 'zeeraa_admin';
}

/**
 * The roles an admin may grant in the tenant they are administering: every
 * role for a Zeeraa admin, none for anybody else. `memberships_admin_write`
 * decides what the database accepts; this decides what the form offers.
 */
export function assignableRoles(role: Role): readonly Role[] {
  return role === 'zeeraa_admin' ? ROLES : [];
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
