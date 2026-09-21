import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  checkPassword,
  generateInitialPassword,
} from '../src/password';

describe('checkPassword', () => {
  it('accepts a long enough password', () => {
    expect(checkPassword('correct horse battery staple')).toBeNull();
  });

  it('rejects anything under the minimum', () => {
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))?.code).toBe('too_short');
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('imposes no composition rule', () => {
    // Twelve lowercase letters is fine. A rule demanding a digit and a symbol
    // pushes people to `Password1!`, which is what a dictionary tries first.
    expect(checkPassword('abcdefghijkl')).toBeNull();
  });

  it('counts codepoints, not UTF-16 units', () => {
    // Eleven emoji are eleven characters to the person typing them. `.length`
    // would say 22 and let a short password through.
    expect(checkPassword('🔒'.repeat(11))?.code).toBe('too_short');
    expect(checkPassword('🔒'.repeat(12))).toBeNull();
  });

  it('rejects whitespace padded out to length', () => {
    expect(checkPassword(' '.repeat(20))?.code).toBe('whitespace_only');
  });

  it('refuses a change that keeps the same password', () => {
    const same = 'correct horse battery staple';
    expect(checkPassword(same, { currentPassword: same })?.code).toBe('same_as_current');
    expect(checkPassword(same, { currentPassword: 'something else entirely' })).toBeNull();
  });

  it('rejects an absurdly long password rather than hashing it', () => {
    expect(checkPassword('a'.repeat(1000))?.code).toBe('too_long');
  });
});

describe('generateInitialPassword', () => {
  it('always clears the policy it has to satisfy', () => {
    // Every draw, not a sample: the shortest possible four-word combination is
    // the one that would fail, and a random test would find it rarely.
    for (let i = 0; i < 200; i += 1) {
      const password = generateInitialPassword((max) => Math.floor(Math.random() * max));
      expect(checkPassword(password)).toBeNull();
    }
  });

  it('draws every element from the caller randomness, never Math.random', () => {
    // Pinning the generator to 0 must produce a deterministic string. If the
    // module reached for its own randomness this would vary.
    const fixed = generateInitialPassword(() => 0);
    expect(generateInitialPassword(() => 0)).toBe(fixed);
    expect(fixed).toBe('anchor-anchor-anchor-anchor-10');
  });
});
