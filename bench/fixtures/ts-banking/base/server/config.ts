import { MINUTE_MS } from "../packages/shared/src/clock.ts";

export interface AppConfig {
  environment: "development" | "test" | "production";
  cache: {
    /** How long a computed dashboard summary may be served from cache. */
    summaryTtlMs: number;
  };
  /** Set the Secure flag on the session cookie (enable behind HTTPS). */
  secureCookies: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  environment: "development",
  cache: { summaryTtlMs: 5 * MINUTE_MS },
  secureCookies: false,
};

export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    cache: { ...DEFAULT_CONFIG.cache, ...overrides.cache },
  };
}

export function configFromEnv(env: Record<string, string | undefined>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  if (env["NODE_ENV"] === "production" || env["NODE_ENV"] === "test") out.environment = env["NODE_ENV"];
  if (env["SECURE_COOKIES"] === "1") out.secureCookies = true;
  const ttl = Number(env["SUMMARY_CACHE_TTL_MS"]);
  if (Number.isFinite(ttl) && ttl > 0) out.cache = { summaryTtlMs: ttl };
  return out;
}
