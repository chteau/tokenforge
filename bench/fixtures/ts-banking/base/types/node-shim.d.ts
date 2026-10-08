// Minimal type declarations for the Node built-ins this project uses.
// The project has no npm dependencies (and therefore no @types/node); extend
// this file when you start using another built-in API.

declare var process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number | undefined;
  cwd(): string;
  exit(code?: number): never;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  hrtime: { bigint(): bigint };
};

interface Buffer extends Uint8Array {
  toString(encoding?: "utf8" | "hex" | "base64" | "base64url"): string;
  equals(other: Uint8Array): boolean;
}

declare var Buffer: {
  from(data: string, encoding?: "utf8" | "hex" | "base64" | "base64url"): Buffer;
  from(data: Uint8Array | ArrayBuffer | readonly number[]): Buffer;
  concat(list: readonly Uint8Array[]): Buffer;
  byteLength(data: string, encoding?: "utf8"): number;
  isBuffer(value: unknown): value is Buffer;
  alloc(size: number): Buffer;
};

interface ImportMeta {
  readonly main: boolean;
  readonly dirname: string;
  readonly filename: string;
}

declare module "node:http" {
  export type IncomingHttpHeaders = Record<string, string | string[] | undefined>;

  export interface IncomingMessage extends AsyncIterable<Buffer> {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    socket: { remoteAddress?: string };
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "end" | "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  }

  export interface ServerResponse {
    statusCode: number;
    headersSent: boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | number | string[] | undefined;
    writeHead(status: number, headers?: Record<string, string | number | string[]>): this;
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array): this;
  }

  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    listen(port: number, callback?: () => void): this;
    close(callback?: (err?: Error) => void): this;
    closeAllConnections(): void;
    address(): AddressInfo | string | null;
    on(event: "error", listener: (err: Error) => void): this;
  }

  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  export function createServer(listener: RequestListener): Server;

  const http: { createServer: typeof createServer };
  export default http;
}

declare module "node:crypto" {
  export interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    maxmem?: number;
  }
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  export interface Hmac {
    update(data: string | Uint8Array): Hmac;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function randomInt(min: number, max: number): number;
  export function scryptSync(password: string | Uint8Array, salt: string | Uint8Array, keylen: number, options?: ScryptOptions): Buffer;
  export function scrypt(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options: ScryptOptions,
    callback: (err: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function createHash(algorithm: "sha256" | "sha1" | "md5"): Hash;
  export function createHmac(algorithm: "sha256", key: string | Uint8Array): Hmac;
}

declare module "node:fs" {
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
  }
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function renameSync(from: string, to: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array, encoding?: "utf8"): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
  const path: {
    join: typeof join;
    resolve: typeof resolve;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    relative: typeof relative;
    sep: string;
  };
  export default path;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function hostname(): string;
  export const EOL: string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:module" {
  export function stripTypeScriptTypes(code: string, options?: { mode?: "strip" | "transform"; sourceUrl?: string }): string;
}

declare module "node:test" {
  type Fn = (t: TestContext) => void | Promise<void>;
  type HookFn = () => void | Promise<void>;
  export interface TestContext {
    name: string;
    skip(message?: string): void;
    todo(message?: string): void;
    diagnostic(message: string): void;
    test(name: string, fn: Fn): Promise<void>;
    after(fn: HookFn): void;
  }
  export interface TestOptions {
    skip?: boolean | string;
    todo?: boolean | string;
    only?: boolean;
    timeout?: number;
    concurrency?: number | boolean;
  }
  export function test(name: string, fn: Fn): Promise<void>;
  export function test(name: string, options: TestOptions, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function describe(name: string, options: TestOptions, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: Fn): Promise<void>;
  export function it(name: string, options: TestOptions, fn: Fn): Promise<void>;
  export function before(fn: HookFn): void;
  export function after(fn: HookFn): void;
  export function beforeEach(fn: HookFn): void;
  export function afterEach(fn: HookFn): void;
  export default test;
}

declare module "node:assert/strict" {
  type ErrorMatcher = RegExp | ((err: unknown) => boolean) | object | (new (...args: never[]) => Error);
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    deepStrictEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: ErrorMatcher, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), expected?: ErrorMatcher, message?: string): Promise<void>;
    doesNotReject(fn: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:assert" {
  import assert from "node:assert/strict";
  export default assert;
}
