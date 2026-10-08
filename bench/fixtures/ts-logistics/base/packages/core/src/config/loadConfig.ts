import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PricingConfig {
  /** profile name -> ordered list of container keys for adjusters */
  profiles: Record<string, string[]>;
  defaultProfile: string;
}

export interface RatesConfig {
  currency: string;
  /** basis points uplift per zone class, see rates/zones */
  zoneUpliftBps: Record<string, number>;
  fuelIndexBps: number;
  residentialFlat: number;
  peak: { from: string; to: string; bps: number };
  volumetricDivisor: number;
}

export interface AppConfig {
  env: string;
  http: { port: number; host: string; bodyLimit: number };
  storage: { dataDir: string };
  features: Record<string, boolean>;
  pricing: PricingConfig;
  rates: RatesConfig;
  tracking: { pollIntervalMs: number; staleAfterHours: number };
  billing: { invoiceDay: number; vatBps: Record<string, number> };
  notify: { webhookTimeoutMs: number; senders: Record<string, string> };
  customs: { holdDestinations: string[]; declaredValueThreshold: number };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override as T;
  if (typeof override !== 'object' || Array.isArray(override)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

/** Applies KESTREL__A__B=value environment overrides (double underscore = nesting). */
export function envOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('KESTREL__') || raw === undefined) continue;
    const parts = key
      .slice('KESTREL__'.length)
      .split('__')
      .map((p) => p.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = (cur[parts[i]] as Record<string, unknown>) ?? {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    let value: unknown = raw;
    if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

export interface LoadOptions {
  root?: string;
  env?: string;
  overrides?: Record<string, unknown>;
  processEnv?: Record<string, string | undefined>;
}

export function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'config', 'default.json'))) return dir;
    dir = join(dir, '..');
  }
  throw new Error(`config/default.json not found above ${start}`);
}

export function loadConfig(opts: LoadOptions = {}): AppConfig {
  const root = opts.root ?? findRoot(process.cwd());
  const env = opts.env ?? process.env.KESTREL_ENV ?? 'development';
  let cfg = readJson(join(root, 'config', 'default.json')) as unknown as AppConfig;
  const envFile = join(root, 'config', `${env}.json`);
  if (existsSync(envFile)) cfg = deepMerge(cfg, readJson(envFile));
  cfg = deepMerge(cfg, envOverrides(opts.processEnv ?? process.env));
  cfg = deepMerge(cfg, opts.overrides ?? {});
  cfg.env = env;
  return cfg;
}
