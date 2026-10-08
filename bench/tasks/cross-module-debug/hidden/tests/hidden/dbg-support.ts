import { createApp } from "../../server/app.ts";
import { createDeps } from "../../server/deps.ts";
import { createManualClock } from "../../packages/shared/src/clock.ts";

const PASSWORDS: Record<string, string> = {
  alice: "alice-harbor-2026",
  bob: "bob-harbor-2026",
  carol: "carol-harbor-2026",
  dana: "dana-harbor-2026",
  olive: "olive-admin-2026",
};

let keyCounter = 0;
export function key(): string {
  keyCounter += 1;
  return `dbg-key-${String(keyCounter).padStart(6, "0")}`;
}

export function world() {
  const clock = createManualClock("2026-10-07T16:00:00.000Z");
  const deps = createDeps({ clock });
  const app = createApp(deps);
  const accountId = (number: string): string => {
    const a = deps.repos.accounts.findByNumber(number);
    if (!a) throw new Error(`missing account ${number}`);
    return a.id;
  };
  const stats = () => deps.caches.summary.stats();
  async function login(username: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", body: { username, password: PASSWORDS[username] } });
    if (res.status !== 200) throw new Error(`login ${username} -> ${res.status}`);
    const token: string = res.json().token;
    const auth = { authorization: `Bearer ${token}` };
    return {
      dashboard: async (): Promise<any> => {
        const r = await app.inject({ method: "GET", url: "/api/dashboard", headers: auth });
        if (r.status !== 200) throw new Error(`dashboard -> ${r.status}`);
        return r.json();
      },
      page: (url: string) => app.inject({ method: "GET", url, headers: { cookie: `qm_session=${token}` } }),
      post: (url: string, body?: unknown, headers: Record<string, string> = {}) =>
        app.inject({ method: "POST", url, body, headers: { ...auth, ...headers } }),
      form: (url: string, fields: Record<string, string>) =>
        app.inject({
          method: "POST",
          url,
          body: new URLSearchParams(fields).toString(),
          headers: { cookie: `qm_session=${token}`, "content-type": "application/x-www-form-urlencoded" },
        }),
      transfer: async (fromNumber: string, toAccount: string, amount: string) => {
        const r = await app.inject({
          method: "POST",
          url: "/api/transfers",
          body: { fromAccountId: accountId(fromNumber), toAccount, amount },
          headers: { ...auth, "idempotency-key": key() },
        });
        if (r.status !== 201) throw new Error(`transfer -> ${r.status} ${r.body}`);
        return r.json();
      },
    };
  }
  return { clock, deps, app, accountId, stats, login };
}

export function balanceOf(dashboard: any, number: string): number | undefined {
  return dashboard.accounts.find((a: { number: string }) => a.number === number)?.balanceMinor;
}

export function total(dashboard: any, currency: string): any {
  return dashboard.totals.find((t: { currency: string }) => t.currency === currency);
}
