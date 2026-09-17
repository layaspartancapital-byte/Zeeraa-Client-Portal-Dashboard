/**
 * The guard that replaces FORCE ROW LEVEL SECURITY.
 *
 * Worth a test of its own: its whole job is to catch a misconfiguration that is
 * otherwise invisible. If it silently stopped firing, the application would
 * keep working and tenant isolation would simply be gone.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { assertRlsEnforced } from '../src/assert-rls';
import { appClient, ownerClient } from './fixtures';

const owner = ownerClient();
const app = appClient();

afterAll(async () => {
  await owner.client.end();
  await app.client.end();
});

describe('assertRlsEnforced', () => {
  it('refuses a connection that can bypass row level security', async () => {
    await expect(assertRlsEnforced(owner.db)).rejects.toThrow(/can bypass row level security/i);
  });

  it('accepts the constrained runtime role', async () => {
    await expect(assertRlsEnforced(app.db)).resolves.toBeUndefined();
  });
});
