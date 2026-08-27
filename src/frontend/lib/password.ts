/** Password generation and a rough strength read-out, both entirely local. */

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

export interface GeneratorOptions {
  length: number;
  digits: boolean;
  symbols: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, digits: true, symbols: true };

/** Rejection sampling over `crypto.getRandomValues` — no modulo bias. */
function randomIndex(bound: number): number {
  const limit = Math.floor(0xffffffff / bound) * bound;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % bound;
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)];
}

export function generatePassword({ length, digits, symbols }: GeneratorOptions): string {
  const groups = [LOWER, UPPER, ...(digits ? [DIGITS] : []), ...(symbols ? [SYMBOLS] : [])];
  const alphabet = groups.join("");

  // Guarantee one character from each enabled group, then fill and shuffle.
  const chars = groups.map(pick);
  while (chars.length < length) chars.push(pick(alphabet));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, Math.max(length, groups.length)).join("");
}

export type StrengthLabel = "empty" | "weak" | "fair" | "good" | "strong";

/** Entropy estimate from the character classes actually used. Indicative, not a guarantee. */
export function passwordStrength(password: string): { bits: number; label: StrengthLabel } {
  if (!password) return { bits: 0, label: "empty" };

  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/[0-9]/.test(password)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 33;

  const unique = new Set(password).size;
  // Repetition penalty: "aaaaaaaa" should not read as an 8-character password.
  const effectiveLength = password.length * Math.min(1, (unique + 1) / password.length);
  const bits = Math.round(effectiveLength * Math.log2(Math.max(poolSize, 2)));

  const label: StrengthLabel = bits < 45 ? "weak" : bits < 70 ? "fair" : bits < 100 ? "good" : "strong";
  return { bits, label };
}
