/**
 * What counts as an acceptable password, as a pure function with tests.
 *
 * Hashing lives in the web app because it needs a native module and a Node
 * runtime; the *rule* lives here, because it has to read the same on the
 * sign-in screen, on the forced-change screen and in the admin form that sets
 * somebody's first password. Three copies of "at least 12 characters" is how
 * they end up disagreeing.
 */

/**
 * Twelve, not eight, and no composition rules.
 *
 * Length is the only requirement that reliably buys entropy. Character-class
 * rules ("one uppercase, one digit, one symbol") push people toward
 * `Password1!` — predictable in exactly the way a cracking dictionary expects —
 * and NIST has recommended against them since SP 800-63B. The upper bound is
 * argon2's practical input limit rather than a policy.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordProblem =
  | { code: 'too_short'; message: string }
  | { code: 'too_long'; message: string }
  | { code: 'whitespace_only'; message: string }
  | { code: 'same_as_current'; message: string };

/**
 * Checks a proposed password. `currentPassword` is passed on a change, so that
 * "change your password" cannot be satisfied by re-entering the one an admin
 * just read out over the phone.
 */
export function checkPassword(
  password: string,
  options: { currentPassword?: string } = {},
): PasswordProblem | null {
  // Codepoints, not UTF-16 units: an emoji is one character to the person
  // typing it, and `.length` would count it as two.
  const length = [...password].length;

  if (length < PASSWORD_MIN_LENGTH) {
    return {
      code: 'too_short',
      message: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return {
      code: 'too_long',
      message: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (password.trim().length === 0) {
    return { code: 'whitespace_only', message: 'Use at least one visible character.' };
  }
  if (options.currentPassword !== undefined && password === options.currentPassword) {
    return {
      code: 'same_as_current',
      message: 'Choose a password you have not used on this account.',
    };
  }
  return null;
}

/**
 * A readable initial password for an admin to hand over out of band.
 *
 * Four words and a number beats a random string here for one reason: it is
 * read aloud, or typed from a note, by somebody who is not the person who
 * generated it. A password that is hard to transcribe gets written somewhere
 * worse, or gets replaced by the admin with something short.
 *
 * `randomInt` is the caller's — `packages/core` stays free of Node imports so
 * it can be bundled anywhere, and a generator seeded by `Math.random` would
 * produce guessable initial passwords.
 */
const WORDS = [
  'anchor', 'basin', 'cedar', 'dorsal', 'ember', 'fathom', 'gallon', 'harbor',
  'indigo', 'juniper', 'kelvin', 'lantern', 'marble', 'nutmeg', 'orbit', 'pewter',
  'quarry', 'ribbon', 'saffron', 'timber', 'umber', 'velvet', 'walnut', 'yonder',
  'zephyr', 'bramble', 'cinder', 'dapple', 'elmwood', 'flint', 'granite', 'hollow',
];

export function generateInitialPassword(randomInt: (maxExclusive: number) => number): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]!);
  // Two digits so the result clears PASSWORD_MIN_LENGTH even on the shortest
  // four-word draw, without a composition rule pretending to add strength.
  return `${words.join('-')}-${String(randomInt(90) + 10)}`;
}
