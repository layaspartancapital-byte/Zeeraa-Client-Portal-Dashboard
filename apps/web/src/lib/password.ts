import 'server-only';
import { randomBytes, randomInt } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { generateInitialPassword } from '@zeeraa/core';

/**
 * argon2id, at the OWASP second-choice parameters: 19 MiB, two passes, one
 * lane.
 *
 * argon2id rather than bcrypt because bcrypt silently truncates at 72 bytes and
 * has no memory cost, so a GPU farm is the whole attack. These settings measure
 * ~12 ms per hash on the deployment's hardware — slow enough to make offline
 * guessing expensive, fast enough that a sign-in does not visibly wait.
 *
 * The parameters travel inside the PHC string (`$argon2id$v=19$m=…,t=…,p=…$…`),
 * so raising the cost later does not invalidate a single stored hash: old
 * hashes keep verifying under the parameters they were written with, and new
 * ones are written under the new cost.
 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A hash of a value nobody can supply, verified against when the account does
 * not exist or holds no password.
 *
 * Without it, "no such user" returns in a fraction of a millisecond while a
 * real account spends ~12 ms hashing, and the difference is a reliable oracle
 * for which addresses hold accounts. Since this product has no self-service
 * signup, that list is exactly what an attacker lacks.
 *
 * Computed once at module load, from random bytes, so it can never match.
 *
 * `randomBytes` rather than `randomInt`: `randomInt`'s ceiling is 2**48 - 1,
 * and asking for 2**48 throws a RangeError. At module scope that is not a
 * failed sign-in, it is every page that imports this file answering 500.
 */
const DECOY_HASH: Promise<string> = hash(randomBytes(32).toString('hex'), PARAMS);

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

/**
 * Verifies a password, taking the same time whether or not the account exists.
 *
 * `storedHash` is null for an account nobody has set a password on. Passing it
 * here rather than short-circuiting at the call site is what keeps the timing
 * flat — the caller cannot forget.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!storedHash) {
    await verify(await DECOY_HASH, password).catch(() => false);
    return false;
  }
  try {
    return await verify(storedHash, password);
  } catch {
    // A stored value that is not a valid PHC string is a corrupt row, not a
    // correct password. Fail closed rather than throwing into the sign-in page.
    return false;
  }
}

/** An initial password for an admin to read out. See `generateInitialPassword`. */
export function newInitialPassword(): string {
  return generateInitialPassword((maxExclusive) => randomInt(maxExclusive));
}
