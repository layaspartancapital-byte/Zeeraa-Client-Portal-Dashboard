import { describe, expect, it } from 'vitest';
import { ROLES, canApproveAssets, canSwitchTenant, isClientRole } from '../src/roles';

describe('roles', () => {
  it('shows the tenant switcher to Zeeraa roles only', () => {
    expect(ROLES.filter(canSwitchTenant)).toEqual(['zeeraa_admin', 'zeeraa_member']);
  });

  it('lets only client_admin approve', () => {
    expect(ROLES.filter(canApproveAssets)).toEqual(['client_admin']);
  });

  it('classifies client roles', () => {
    expect(ROLES.filter(isClientRole)).toEqual(['client_admin', 'client_viewer']);
  });
});
