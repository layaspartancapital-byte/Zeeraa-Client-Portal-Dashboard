import { describe, expect, it } from 'vitest';
import { ROLES, assignableRoles, canManageUsers, canSwitchTenant, isClientRole } from '../src/roles';

describe('roles', () => {
  it('shows the tenant switcher to Zeeraa roles only', () => {
    expect(ROLES.filter(canSwitchTenant)).toEqual(['zeeraa_admin', 'zeeraa_member']);
  });

  it('classifies client roles', () => {
    expect(ROLES.filter(isClientRole)).toEqual(['client_admin', 'client_viewer']);
  });
});

/**
 * People is a Zeeraa admin's alone (23 September 2026). A client admin able to
 * reset a Zeeraa admin's password could sign in as someone who reaches every
 * client, so this is a security boundary, not a preference.
 */
describe('who manages accounts', () => {
  it('is the Zeeraa admin and nobody else', () => {
    expect(ROLES.filter(canManageUsers)).toEqual(['zeeraa_admin']);
  });

  it('lets nobody else grant any role at all', () => {
    for (const role of ROLES.filter((r) => r !== 'zeeraa_admin')) {
      expect(assignableRoles(role)).toEqual([]);
    }
  });
});
