// Tiny schema validation used at the API boundary. Routes call
// `parseOrThrow(schema, body)`; failures become a VALIDATION_ERROR (HTTP 400)
// whose details list every offending field.
//
//   const schema = v.object({ name: v.string({ max: 40 }), limit: v.optional(v.integer({ min: 1 })) });
//   const input = parseOrThrow(schema, ctx.body);

import { type ErrorDetail, validationError } from "./errors.ts";
import { type Result, err, ok } from "./result.ts";
import { type Currency, isCurrency } from "./money.ts";
import { isValidIsoDate, isValidTimeZone } from "./dates.ts";

export type Issue = ErrorDetail & { field: string };
export type Validator<T> = (value: unknown, field: string) => Result<T, Issue[]>;
export type Infer<V> = V extends Validator<infer T> ? T : never;

function issue(field: string, message: string): Result<never, Issue[]> {
  return err([{ field, message }]);
}

export interface StringRules {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
  patternMessage?: string;
}

function string(rules: StringRules = {}): Validator<string> {
  return (value, field) => {
    if (typeof value !== "string") return issue(field, "must be a string");
    const s = rules.trim === false ? value : value.trim();
    if (rules.min !== undefined && s.length < rules.min) {
      return issue(field, rules.min === 1 ? "is required" : `must be at least ${rules.min} characters`);
    }
    if (rules.max !== undefined && s.length > rules.max) return issue(field, `must be at most ${rules.max} characters`);
    if (rules.pattern && !rules.pattern.test(s)) return issue(field, rules.patternMessage ?? "has an invalid format");
    return ok(s);
  };
}

export interface IntegerRules {
  min?: number;
  max?: number;
}

function integer(rules: IntegerRules = {}): Validator<number> {
  return (value, field) => {
    const n = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n)) return issue(field, "must be an integer");
    if (rules.min !== undefined && n < rules.min) return issue(field, `must be >= ${rules.min}`);
    if (rules.max !== undefined && n > rules.max) return issue(field, `must be <= ${rules.max}`);
    return ok(n);
  };
}

function boolean(): Validator<boolean> {
  return (value, field) => {
    if (typeof value === "boolean") return ok(value);
    if (value === "true" || value === "on" || value === "1") return ok(true);
    if (value === "false" || value === "0") return ok(false);
    return issue(field, "must be a boolean");
  };
}

function oneOf<const T extends string>(options: readonly T[]): Validator<T> {
  return (value, field) =>
    typeof value === "string" && (options as readonly string[]).includes(value)
      ? ok(value as T)
      : issue(field, `must be one of: ${options.join(", ")}`);
}

function isoDate(): Validator<string> {
  return (value, field) =>
    typeof value === "string" && isValidIsoDate(value) ? ok(value) : issue(field, "must be a valid date (YYYY-MM-DD)");
}

function timeZone(): Validator<string> {
  return (value, field) =>
    typeof value === "string" && isValidTimeZone(value) ? ok(value) : issue(field, "must be a valid IANA time zone");
}

function currency(): Validator<Currency> {
  return (value, field) => (isCurrency(value) ? ok(value) : issue(field, "must be a supported currency code"));
}

/** A decimal amount kept as a string ("12.50"); convert with parseAmount() once the currency is known. */
function decimalString(): Validator<string> {
  return (value, field) => {
    const s = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof s !== "string" || !/^\d{1,12}(\.\d{1,4})?$/.test(s.trim())) {
      return issue(field, "must be a positive decimal amount such as 12.50");
    }
    return ok(s.trim());
  };
}

function id(prefix: string): Validator<string> {
  const pattern = new RegExp(`^${prefix}_[A-Za-z0-9]{4,32}$`);
  return (value, field) =>
    typeof value === "string" && pattern.test(value.trim()) ? ok(value.trim()) : issue(field, "must be a valid identifier");
}

function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, field) => (value === undefined || value === null || value === "" ? ok(undefined) : inner(value, field));
}

function withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return (value, field) => (value === undefined || value === null || value === "" ? ok(fallback) : inner(value, field));
}

function array<T>(inner: Validator<T>, rules: { max?: number } = {}): Validator<T[]> {
  return (value, field) => {
    if (!Array.isArray(value)) return issue(field, "must be an array");
    if (rules.max !== undefined && value.length > rules.max) return issue(field, `must have at most ${rules.max} items`);
    const out: T[] = [];
    const issues: Issue[] = [];
    value.forEach((item, i) => {
      const r = inner(item, `${field}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.error);
    });
    return issues.length ? err(issues) : ok(out);
  };
}

type Shape = Record<string, Validator<unknown>>;
type ShapeOutput<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

function object<S extends Shape>(shape: S): Validator<ShapeOutput<S>> {
  return (value, field) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return issue(field || "body", "must be an object");
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [key, validator] of Object.entries(shape)) {
      const r = validator(record[key], field ? `${field}.${key}` : key);
      if (r.ok) {
        if (r.value !== undefined) out[key] = r.value;
      } else {
        issues.push(...r.error);
      }
    }
    return issues.length ? err(issues) : ok(out as ShapeOutput<S>);
  };
}

export const v = {
  string,
  integer,
  boolean,
  oneOf,
  isoDate,
  timeZone,
  currency,
  decimalString,
  id,
  optional,
  withDefault,
  array,
  object,
};

export function parse<T>(validator: Validator<T>, value: unknown): Result<T, Issue[]> {
  return validator(value, "");
}

export function parseOrThrow<T>(validator: Validator<T>, value: unknown): T {
  const result = validator(value, "");
  if (!result.ok) throw validationError(result.error);
  return result.value;
}

/** Convert URLSearchParams to a plain object (last value wins) for schema parsing. */
export function queryToObject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of query) out[key] = value;
  return out;
}
