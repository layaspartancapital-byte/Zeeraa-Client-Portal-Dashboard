/**
 * The guard that replaces FORCE ROW LEVEL SECURITY.
 *
 * Worth a test of its own: its whole job is to catch a misconfiguration that is
 * otherwise invisible. If it silently stopped firing, the application would
 * keep working and tenant isolation would simply be gone.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { assertRlsEnforced } from '../src/assert-rls';
import { adminClient, appClient, ownerClient } from './fixtures';

const admin = adminClient();
const owner = ownerClient();
const app = appClient();

afterAll(async () => {
  await Promise.all([admin.client.end(), owner.client.end(), app.client.end()]);
});

describe('assertRlsEnforced', () => {
  it('refuses a superuser connection', async () => {
    await expect(assertRlsEnforced(admin.db)).rejects.toThrow(/can bypass row level security/i);
  });

  it('accepts the constrained runtime role', async () => {
    await expect(assertRlsEnforced(app.db)).resolves.toBeUndefined();
  });

  it('accepts the owner role, which no longer bypasses anything', async () => {
    // Worth asserting: the guard is about bypass capability, not about being
    // the owner. Since migrations moved off the superuser, `zeeraa_owner` is a
    // perfectly ordinary role that FORCE binds.
    await expect(assertRlsEnforced(owner.db)).resolves.toBeUndefined();
  });
});
