import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

// Format: scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
const KEY_LENGTH = 32;
export const DEFAULT_SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Synchronous variant for scripts and seed generation only. */
export function hashPasswordSync(password: string, params: ScryptParams = DEFAULT_SCRYPT): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { ...params, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await deriveKey(password, Buffer.from(saltB64, "base64url"), params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type PasswordPolicyIssue = {
  field: "password";
  message: string;
};

export function checkPasswordPolicy(password: string): PasswordPolicyIssue[] {
  const issues: PasswordPolicyIssue[] = [];
  if (password.length < 12) issues.push({ field: "password", message: "must be at least 12 characters" });
  if (!/[a-z]/i.test(password)) issues.push({ field: "password", message: "must contain a letter" });
  if (!/\d/.test(password)) issues.push({ field: "password", message: "must contain a digit" });
  return issues;
}
