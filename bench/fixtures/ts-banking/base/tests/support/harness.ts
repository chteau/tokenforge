// Shared test setup: a fully wired app on seed data, a manual clock, and
// helpers to sign in as a seed user and call the API without opening sockets.

import { type App, type InjectResponse, createApp } from "../../server/app.ts";
import { type AppDeps, type CreateDepsOptions, createDeps } from "../../server/deps.ts";
import { type ManualClock, createManualClock } from "../../packages/shared/src/clock.ts";
import { SEED_PASSWORDS } from "../../seed/seed-data.ts";

export const TEST_NOW = "2026-10-07T16:00:00.000Z";

export type SeedUsername = keyof typeof SEED_PASSWORDS;

export interface TestClient {
  token: string;
  get(url: string, headers?: Record<string, string>): Promise<InjectResponse>;
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<InjectResponse>;
  patch(url: string, body?: unknown, headers?: Record<string, string>): Promise<InjectResponse>;
  put(url: string, body?: unknown, headers?: Record<string, string>): Promise<InjectResponse>;
  delete(url: string, headers?: Record<string, string>): Promise<InjectResponse>;
  /** Fetch a server-rendered page with the session cookie. */
  page(url: string): Promise<InjectResponse>;
  /** Submit an urlencoded form with the session cookie. */
  form(url: string, fields: Record<string, string>): Promise<InjectResponse>;
}

export interface TestContext {
  deps: AppDeps;
  app: App;
  clock: ManualClock;
  login(username: SeedUsername): Promise<TestClient>;
  accountId(number: string): string;
  userId(username: string): string;
}

export function setup(options: Omit<CreateDepsOptions, "clock"> & { now?: string } = {}): TestContext {
  const clock = createManualClock(options.now ?? TEST_NOW);
  const deps = createDeps({ ...options, clock });
  const app = createApp(deps);

  async function login(username: SeedUsername): Promise<TestClient> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      body: { username, password: SEED_PASSWORDS[username] },
    });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${res.body}`);
    const token: string = res.json().token;
    const auth = { authorization: `Bearer ${token}` };
    const cookie = { cookie: `qm_session=${token}` };
    return {
      token,
      get: (url, headers = {}) => app.inject({ method: "GET", url, headers: { ...auth, ...headers } }),
      post: (url, body, headers = {}) => app.inject({ method: "POST", url, body, headers: { ...auth, ...headers } }),
      patch: (url, body, headers = {}) => app.inject({ method: "PATCH", url, body, headers: { ...auth, ...headers } }),
      put: (url, body, headers = {}) => app.inject({ method: "PUT", url, body, headers: { ...auth, ...headers } }),
      delete: (url, headers = {}) => app.inject({ method: "DELETE", url, headers: { ...auth, ...headers } }),
      page: (url) => app.inject({ method: "GET", url, headers: cookie }),
      form: (url, fields) =>
        app.inject({
          method: "POST",
          url,
          body: new URLSearchParams(fields).toString(),
          headers: { ...cookie, "content-type": "application/x-www-form-urlencoded" },
        }),
    };
  }

  return {
    deps,
    app,
    clock,
    login,
    accountId(number) {
      const account = deps.repos.accounts.findByNumber(number);
      if (!account) throw new Error(`no seed account ${number}`);
      return account.id;
    },
    userId(username) {
      const user = deps.repos.users.findByUsername(username);
      if (!user) throw new Error(`no seed user ${username}`);
      return user.id;
    },
  };
}

let keyCounter = 0;
export function idemKey(label = "t"): string {
  keyCounter += 1;
  return `${label}-key-${String(keyCounter).padStart(6, "0")}`;
}
