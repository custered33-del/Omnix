const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

let deterministicCounter: number | null = null;

/** Make ids predictable (for tests and reproducible fixtures). Pass null to restore random ids. */
export function setDeterministicIds(start: number | null): void {
  deterministicCounter = start;
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Short, URL-safe unique id with an optional readable prefix, e.g. `lyr_4fK2...`. */
export function newId(prefix = ''): string {
  if (deterministicCounter !== null) {
    deterministicCounter += 1;
    return `${prefix ? prefix + '_' : ''}${deterministicCounter.toString().padStart(6, '0')}`;
  }
  const bytes = randomBytes(14);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}
