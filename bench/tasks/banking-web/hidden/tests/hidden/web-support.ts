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

export function world() {
  const clock = createManualClock("2026-10-07T16:00:00.000Z");
  const deps = createDeps({ clock });
  const app = createApp(deps);
  const accountId = (number: string): string => {
    const a = deps.repos.accounts.findByNumber(number);
    if (!a) throw new Error(`missing account ${number}`);
    return a.id;
  };
  async function login(username: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", body: { username, password: PASSWORDS[username] } });
    if (res.status !== 200) throw new Error(`login ${username} -> ${res.status}`);
    const token: string = res.json().token;
    return {
      get: (url: string): Promise<Res> => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
      patch: (url: string, body: unknown): Promise<Res> =>
        app.inject({ method: "PATCH", url, body, headers: { authorization: `Bearer ${token}` } }),
      page: (url: string): Promise<Res> => app.inject({ method: "GET", url, headers: { cookie: `qm_session=${token}` } }),
    };
  }
  return { clock, deps, app, accountId, login };
}

export function descriptions(res: Res): string[] {
  return res.json().items.map((i: { description: string }) => i.description);
}

export function fields(res: Res): string[] {
  return (res.json().error?.details ?? []).map((d: { field: string }) => d.field);
}

export function header(res: Res, name: string): string {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Every <a ...> tag in the page as { attrs, href }. */
export function anchors(htmlText: string): { tag: string; href: string }[] {
  return [...htmlText.matchAll(/<a\b[^>]*>/gi)].map((m) => {
    const tag = m[0];
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? "";
    return { tag, href: decodeEntities(href) };
  });
}

/** The value attribute of the input/select-free field named `name`. */
export function inputValue(htmlText: string, name: string): string | undefined {
  for (const m of htmlText.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (new RegExp(`\\bname\\s*=\\s*["']${name}["']`, "i").test(tag)) {
      const v = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bvalue\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? "";
      return decodeEntities(v);
    }
  }
  return undefined;
}
