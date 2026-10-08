import { createApp } from "../../server/app.ts";
import { createDeps } from "../../server/deps.ts";
import { createManualClock } from "../../packages/shared/src/clock.ts";

const PASSWORDS: Record<string, string> = {
  alice: "alice-harbor-2026",
  bob: "bob-harbor-2026",
  carol: "carol-harbor-2026",
  dana: "dana-harbor-2026",
  olive: "olive-admin-2026",
  sam: "sam-support-2026",
};

export interface Res {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  json(): any;
}

let keyCounter = 0;
export function key(label = "sched"): string {
  keyCounter += 1;
  return `${label}-${String(keyCounter).padStart(6, "0")}`;
}

export function world(options: { now?: string; dataFile?: string } = {}) {
  const clock = createManualClock(options.now ?? "2026-10-07T16:00:00.000Z");
  const deps = createDeps({ clock, ...(options.dataFile ? { dataFile: options.dataFile } : {}) });
  const app = createApp(deps);
  const accountId = (number: string): string => {
    const a = deps.repos.accounts.findByNumber(number);
    if (!a) throw new Error(`missing account ${number}`);
    return a.id;
  };
  const balance = (number: string): number => deps.repos.accounts.findByNumber(number)?.balanceMinor ?? NaN;
  async function login(username: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", body: { username, password: PASSWORDS[username] } });
    if (res.status !== 200) throw new Error(`login ${username} -> ${res.status}`);
    const token: string = res.json().token;
    const auth = { authorization: `Bearer ${token}` };
    const cookie = { cookie: `qm_session=${token}` };
    return {
      get: (url: string): Promise<Res> => app.inject({ method: "GET", url, headers: auth }),
      post: (url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
        app.inject({ method: "POST", url, body, headers: { ...auth, ...headers } }),
      patch: (url: string, body: unknown): Promise<Res> => app.inject({ method: "PATCH", url, body, headers: auth }),
      del: (url: string): Promise<Res> => app.inject({ method: "DELETE", url, headers: auth }),
      page: (url: string): Promise<Res> => app.inject({ method: "GET", url, headers: cookie }),
      form: (url: string, fields: Record<string, string>): Promise<Res> =>
        app.inject({
          method: "POST",
          url,
          body: new URLSearchParams(fields).toString(),
          headers: { ...cookie, "content-type": "application/x-www-form-urlencoded" },
        }),
      schedule: (body: Record<string, unknown>, idem: string | null = key()): Promise<Res> =>
        app.inject({
          method: "POST",
          url: "/api/scheduled-transfers",
          body,
          headers: { ...auth, ...(idem === null ? {} : { "idempotency-key": idem }) },
        }),
      transfer: (body: Record<string, unknown>): Promise<Res> =>
        app.inject({ method: "POST", url: "/api/transfers", body, headers: { ...auth, "idempotency-key": key("now") } }),
    };
  }
  async function run(): Promise<Res> {
    const olive = await login("olive");
    return olive.post("/api/admin/scheduled-transfers/run");
  }
  return { clock, deps, app, accountId, balance, login, run };
}

export function fields(res: Res): string[] {
  return (res.json().error?.details ?? []).map((d: { field: string }) => d.field);
}
