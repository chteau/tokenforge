import { ValidationError } from '../http/errors.ts';

export type Issue = { path: string; message: string };

export class Checker {
  readonly issues: Issue[] = [];

  require(cond: boolean, path: string, message: string): this {
    if (!cond) this.issues.push({ path, message });
    return this;
  }

  string(v: unknown, path: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): v is string {
    if (typeof v !== 'string') {
      this.issues.push({ path, message: 'must be a string' });
      return false;
    }
    if (opts.min !== undefined && v.length < opts.min) this.issues.push({ path, message: `must be at least ${opts.min} chars` });
    if (opts.max !== undefined && v.length > opts.max) this.issues.push({ path, message: `must be at most ${opts.max} chars` });
    if (opts.pattern && !opts.pattern.test(v)) this.issues.push({ path, message: 'has an invalid format' });
    return true;
  }

  number(v: unknown, path: string, opts: { min?: number; max?: number; integer?: boolean } = {}): v is number {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      this.issues.push({ path, message: 'must be a number' });
      return false;
    }
    if (opts.integer && !Number.isInteger(v)) this.issues.push({ path, message: 'must be an integer' });
    if (opts.min !== undefined && v < opts.min) this.issues.push({ path, message: `must be >= ${opts.min}` });
    if (opts.max !== undefined && v > opts.max) this.issues.push({ path, message: `must be <= ${opts.max}` });
    return true;
  }

  oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): v is T {
    if (typeof v !== 'string' || !values.includes(v as T)) {
      this.issues.push({ path, message: `must be one of ${values.join(', ')}` });
      return false;
    }
    return true;
  }

  object(v: unknown, path: string): v is Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.issues.push({ path, message: 'must be an object' });
      return false;
    }
    return true;
  }

  throwIfInvalid(message = 'request validation failed'): void {
    if (this.issues.length) throw new ValidationError(message, this.issues);
  }
}

export function isCountry(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Z]{2}$/.test(v);
}
