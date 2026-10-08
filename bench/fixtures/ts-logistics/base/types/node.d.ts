// Minimal ambient declarations for the Node built-ins this repository uses.
// The project has no npm dependencies, so @types/node is not available.

declare var process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
};

declare var console: {
  log(...a: unknown[]): void;
  error(...a: unknown[]): void;
  warn(...a: unknown[]): void;
};

declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function clearTimeout(t: unknown): void;
declare function setInterval(fn: () => void, ms?: number): unknown;
declare function clearInterval(t: unknown): void;

declare class URLSearchParams {
  constructor(init?: string | Record<string, string>);
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  toString(): string;
}

declare class URL {
  constructor(input: string, base?: string);
  pathname: string;
  search: string;
  searchParams: URLSearchParams;
  href: string;
}

declare class AbortSignal {
  readonly aborted: boolean;
}

interface ImportMeta {
  main: boolean;
  url: string;
  dirname: string;
  filename: string;
}

declare class Buffer extends Uint8Array {
  static concat(list: Uint8Array[]): Buffer;
  static from(s: string, enc?: string): Buffer;
  toString(enc?: string): string;
}

declare function fetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; ok: boolean; json(): Promise<any>; text(): Promise<string>; headers: { get(n: string): string | null } }>;

declare module 'node:fs' {
  export function readFileSync(path: string, enc: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(u: string): string;
}

declare module 'node:crypto' {
  export function randomBytes(n: number): Uint8Array;
  export function createHmac(alg: string, key: string): { update(d: string): { digest(enc: 'hex'): string } };
}

declare module 'node:net' {
  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }
}

declare module 'node:http' {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, cb: () => void): void;
    address(): unknown;
    close(cb: (err?: Error) => void): void;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Server;
}

declare module 'node:test' {
  type Fn = (t: any) => void | Promise<void>;
  interface TestFn {
    (name: string, fn: Fn): Promise<void>;
    (name: string, opts: Record<string, unknown>, fn: Fn): Promise<void>;
  }
  const test: TestFn;
  export default test;
  export const describe: (name: string, fn: () => void) => void;
  export const it: TestFn;
  export const before: (fn: () => void | Promise<void>) => void;
  export const after: (fn: () => void | Promise<void>) => void;
  export const beforeEach: (fn: () => void | Promise<void>) => void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(a: unknown, b: unknown, message?: string): void;
    notEqual(a: unknown, b: unknown, message?: string): void;
    deepEqual(a: unknown, b: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>;
    match(s: string, re: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
