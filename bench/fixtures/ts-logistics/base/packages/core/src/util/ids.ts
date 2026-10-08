import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function shortId(bytes = 10): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function prefixedId(prefix: string): string {
  return `${prefix}_${shortId()}`;
}

let seq = 0;
/** Deterministic ids for tests: KESTREL_DETERMINISTIC_IDS=1 */
export function newId(prefix: string): string {
  if (process.env.KESTREL_DETERMINISTIC_IDS === '1') {
    seq += 1;
    return `${prefix}_${String(seq).padStart(6, '0')}`;
  }
  return prefixedId(prefix);
}
