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

/** Only `client_admin` approves or requests changes (§10). */
export function canApproveAssets(role: Role): boolean {
  return role === 'client_admin';
}

export function canComment(role: Role): boolean {
  return true;
}

/** Uploading deliverables into the workspace is Zeeraa-side work. */
export function canUploadAssets(role: Role): boolean {
  return isZeeraaRole(role);
}

export function canManageConnections(role: Role): boolean {
  return role === 'zeeraa_admin';
}

/** "Sync now", admin screens, target reconciliation. */
export function canAdministerTenant(role: Role): boolean {
  return role === 'zeeraa_admin';
}

/** Sync failures and SLA-breach warnings are Zeeraa-only notifications (§11). */
export function canSeeOperationalAlerts(role: Role): boolean {
  return isZeeraaRole(role);
}

/** Owner, due date and blocker columns on the delivery view (§9.4). */
export function canSeeInternalDeliveryColumns(role: Role): boolean {
  return isZeeraaRole(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  zeeraa_admin: 'Zeeraa admin',
  zeeraa_member: 'Zeeraa team',
  client_admin: 'Client admin',
  client_viewer: 'Client viewer',
};
