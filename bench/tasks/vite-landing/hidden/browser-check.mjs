// Black-box DOM checks for the landing page, driven over the Chrome DevTools Protocol.
// Usage: node browser-check.mjs <url> <chrome-binary>
// Prints one JSON line {"results": {testName: bool}, "notes": {testName: string}}.
// No npm dependencies: Node's built-in fetch and WebSocket only.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, chromeBin = "/usr/bin/google-chrome"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const notes = {};

// ---------------- Chrome / CDP plumbing ----------------
const profile = mkdtempSync(join(tmpdir(), "landing-chrome-"));
const chrome = spawn(chromeBin, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", "--window-size=1280,900",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

function cleanup() {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function devtoolsPort() {
  const f = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150; i++) {
    if (existsSync(f)) {
      const port = readFileSync(f, "utf8").split("\n")[0].trim();
      if (port) return port;
    }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 15000);
  });
}

async function connect() {
  const port = await devtoolsPort();
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("no page target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// Page-side helpers injected after every load.
const HELPERS = `
window.__t = {
  q: (s, root) => (root || document).querySelector('[data-testid="' + s + '"]'),
  qa: (s, root) => Array.from((root || document).querySelectorAll('[data-testid="' + s + '"]')),
  txt: (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null,
  vis: (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  setValue: (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  until: async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (fn()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 50)); }
    try { return !!fn(); } catch (e) { return false; }
  },
};
true;
`;

async function load() {
  await send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try {
      const ready = await evaluate(`document.readyState === "complete"`);
      if (ready) break;
    } catch {}
  }
  await sleep(300);
  await evaluate(HELPERS);
}

async function check(name, expr) {
  try {
    const v = await evaluate(`(async () => { const t = window.__t; ${expr} })()`);
    results[name] = v === true;
    if (v !== true) notes[name] = JSON.stringify(v)?.slice(0, 300);
  } catch (e) {
    results[name] = false;
    notes[name] = String(e.message || e).slice(0, 300);
  }
}

async function pressEscape() {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
}

// ---------------- expected data ----------------
const FEATURES = [
  ["Shared timelines", "See every project and deadline on one calendar your whole team can edit."],
  ["Smart reminders", "Orbitly nudges the right person before a task slips, not after."],
  ["Workload balance", "Spot overloaded teammates at a glance and rebalance work in one drag."],
  ["Integrations", "Connect GitHub, Slack and Google Calendar in under a minute."],
  ["Reports that write themselves", "Weekly progress summaries land in your inbox every Monday."],
  ["Private by default", "Granular permissions keep client work visible only to the people on it."],
];
const PLANS = [["Starter", "$0/mo", "$0/yr"], ["Team", "$12/mo", "$120/yr"], ["Business", "$29/mo", "$290/yr"]];
const FAQ = [
  ["Is there a free plan?", "Yes. Starter is free forever for up to 3 people."],
  ["Can I cancel anytime?", "Yes. Paid plans can be cancelled at any time from your settings."],
  ["Do you offer discounts for nonprofits?", "Yes. Nonprofits get 50% off any paid plan."],
];
const J = JSON.stringify;

async function openModal() {
  return evaluate(`(async () => { const t = window.__t; const b = t.q('cta-button'); if (!b) return false; b.click();
    return t.until(() => t.vis(t.q('signup-modal'))); })()`);
}

async function submitEmail(value) {
  // Returns {text, state, input} after submitting `value` in the signup form.
  return evaluate(`(async () => { const t = window.__t;
    const m = t.q('signup-modal'); if (!t.vis(m)) { t.q('cta-button')?.click(); await t.until(() => t.vis(t.q('signup-modal'))); }
    const input = t.q('email-input'); const btn = t.q('signup-submit');
    if (!input || !btn) return null;
    window.__probe = 1;
    t.setValue(input, ${J(value)});
    await new Promise(r => setTimeout(r, 50));
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    const msg = t.q('form-message');
    return { text: t.txt(msg), state: msg ? msg.getAttribute('data-state') : null, input: t.q('email-input')?.value ?? null,
             alive: window.__probe === 1 };
  })()`);
}

async function main() {
  await connect();
  await load();

  // ---- structure ----
  await check("STRUCT: document title", `return document.title.trim() === ${J("Orbitly — Plan less. Ship more.")} || document.title;`);
  await check("STRUCT: header shows brand", `const h = t.q('site-header'); return !!h && h.tagName === 'HEADER' && t.txt(h).includes('Orbitly');`);
  await check("STRUCT: nav links text and hrefs in order", `
    const h = t.q('site-header'); const nav = h && h.querySelector('nav'); if (!nav) return 'no nav';
    const got = Array.from(nav.querySelectorAll('a')).map(a => [t.txt(a), a.getAttribute('href')]);
    return JSON.stringify(got) === ${J(J([["Features", "#features"], ["Pricing", "#pricing"], ["FAQ", "#faq"]]))} || got;`);
  await check("STRUCT: sections exist", `return ['features','pricing','faq'].every(id => !!document.getElementById(id));`);
  await check("STRUCT: nav targets scroll into view", `
    const a = Array.from(document.querySelectorAll('nav a')).find(a => a.getAttribute('href') === '#faq'); if (!a) return false;
    a.click(); const ok = await t.until(() => { const r = document.getElementById('faq').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }, 3000);
    scrollTo(0, 0); return ok;`);

  // ---- hero ----
  await check("HERO: headline", `const h = t.q('hero'); const h1 = h && h.querySelector('h1'); return t.txt(h1) === 'Plan less. Ship more.' || t.txt(h1);`);
  await check("HERO: CTA button", `const b = t.q('cta-button'); return !!b && b.tagName === 'BUTTON' && t.txt(b) === 'Get early access' && !!t.q('hero').contains(b);`);

  // ---- modal ----
  await load();
  await check("MODAL: hidden on load", `return !t.vis(t.q('signup-modal'));`);
  await check("MODAL: CTA opens dialog", `t.q('cta-button').click(); const ok = await t.until(() => t.vis(t.q('signup-modal')));
    const m = t.q('signup-modal'); return ok && (m.tagName === 'DIALOG' || m.getAttribute('role') === 'dialog');`);
  await check("MODAL: contains signup form", `const m = t.q('signup-modal'); const f = t.q('signup-form');
    return !!m && !!f && f.tagName === 'FORM' && m.contains(f) && t.vis(t.q('email-input')) && t.vis(t.q('signup-submit'));`);
  await check("MODAL: close button hides it", `const c = t.q('modal-close'); if (!c) return 'no close'; c.click();
    return t.until(() => !t.vis(t.q('signup-modal')));`);
  await check("MODAL: reopens after closing", `t.q('cta-button').click(); return t.until(() => t.vis(t.q('signup-modal')));`);
  {
    const name = "MODAL: Escape hides it";
    try {
      const open = await evaluate(`(async () => { const t = window.__t; if (!t.vis(t.q('signup-modal'))) t.q('cta-button').click();
        const ok = await t.until(() => t.vis(t.q('signup-modal'))); (t.q('email-input') || t.q('signup-modal')).focus(); return ok; })()`);
      await pressEscape();
      const closed = await evaluate(`window.__t.until(() => !window.__t.vis(window.__t.q('signup-modal')))`);
      results[name] = open === true && closed === true;
      if (!results[name]) notes[name] = J({ open, closed });
    } catch (e) { results[name] = false; notes[name] = String(e.message || e); }
  }

  // ---- signup form ----
  await load();
  const formCase = async (name, value, expect) => {
    try {
      const r = await submitEmail(value);
      const ok = !!r && r.text === expect.text && r.state === expect.state && r.alive &&
        (expect.input === undefined || r.input === expect.input);
      results[name] = ok;
      if (!ok) notes[name] = J(r);
    } catch (e) { results[name] = false; notes[name] = String(e.message || e); }
  };
  const EMPTY = { text: "Please enter your email address.", state: "error" };
  const INVALID = { text: "Please enter a valid email address.", state: "error" };
  await formCase("FORM: empty email", "", EMPTY);
  await formCase("FORM: whitespace-only email", "   ", EMPTY);
  await formCase("FORM: missing @ rejected", "ada.example.com", INVALID);
  await formCase("FORM: missing domain dot rejected", "ada@example", INVALID);
  await formCase("FORM: inner whitespace rejected", "ada lovelace@example.com", INVALID);
  await formCase("FORM: double @ rejected", "ada@@example.com", INVALID);
  await formCase("FORM: empty TLD rejected", "ada@example.", INVALID);
  await formCase("FORM: valid email trimmed and lowercased", "  Ada@Example.COM  ",
    { text: "Thanks! We'll be in touch at ada@example.com.", state: "success", input: "" });
  await formCase("FORM: error after success", "nope", INVALID);
  await formCase("FORM: second valid email", "grace.hopper@navy.mil",
    { text: "Thanks! We'll be in touch at grace.hopper@navy.mil.", state: "success", input: "" });
  await check("FORM: no page reload or navigation", `return !!window.__t && location.pathname === new URL(${J(url)}).pathname && !location.search;`);

  // ---- features ----
  await load();
  await check("FEATURES: six cards inside #features", `const s = document.getElementById('features'); const c = t.qa('feature-card');
    return c.length === 6 && c.every(x => s && s.contains(x)) || c.length;`);
  await check("FEATURES: titles in order", `const got = t.qa('feature-card').map(c => t.txt(c.querySelector('h3')));
    return JSON.stringify(got) === ${J(J(FEATURES.map((f) => f[0])))} || got;`);
  await check("FEATURES: descriptions match", `const got = t.qa('feature-card').map(c => t.txt(c.querySelector('p')));
    return JSON.stringify(got) === ${J(J(FEATURES.map((f) => f[1])))} || got;`);

  // ---- pricing ----
  const prices = `t.qa('plan-card').map(c => t.txt(t.q('plan-price', c)))`;
  await check("PRICING: three plans in order", `const s = document.getElementById('pricing'); const cards = t.qa('plan-card');
    const got = cards.map(c => t.txt(t.q('plan-name', c)));
    return JSON.stringify(got) === ${J(J(PLANS.map((p) => p[0])))} && cards.every(c => s && s.contains(c)) || got;`);
  await check("PRICING: monthly by default", `const m = t.q('billing-monthly'), y = t.q('billing-yearly'); if (!m || !y) return 'missing toggle';
    const got = ${prices}; return t.txt(m) === 'Monthly' && t.txt(y) === 'Yearly' && m.getAttribute('aria-pressed') === 'true' &&
      y.getAttribute('aria-pressed') === 'false' && JSON.stringify(got) === ${J(J(PLANS.map((p) => p[1])))} || got;`);
  await check("PRICING: yearly toggle switches prices", `t.q('billing-yearly').click();
    const ok = await t.until(() => JSON.stringify(${prices}) === ${J(J(PLANS.map((p) => p[2])))}); return ok || ${prices};`);
  await check("PRICING: yearly button pressed state", `return t.q('billing-yearly').getAttribute('aria-pressed') === 'true' &&
    t.q('billing-monthly').getAttribute('aria-pressed') === 'false';`);
  await check("PRICING: monthly toggle switches back", `t.q('billing-monthly').click();
    const ok = await t.until(() => JSON.stringify(${prices}) === ${J(J(PLANS.map((p) => p[1])))});
    return ok && t.q('billing-monthly').getAttribute('aria-pressed') === 'true' && t.q('billing-yearly').getAttribute('aria-pressed') === 'false' || ${prices};`);

  // ---- FAQ ----
  await check("FAQ: three items in order", `const s = document.getElementById('faq'); const items = t.qa('faq-item');
    const got = items.map(i => t.txt(t.q('faq-question', i)));
    return JSON.stringify(got) === ${J(J(FAQ.map((f) => f[0])))} && items.every(i => s && s.contains(i)) || got;`);
  await check("FAQ: answers text", `const got = t.qa('faq-item').map(i => t.txt(t.q('faq-answer', i)));
    return JSON.stringify(got) === ${J(J(FAQ.map((f) => f[1])))} || got;`);
  await check("FAQ: answers hidden initially", `const a = t.qa('faq-answer'); return a.length === 3 && a.every(x => !t.vis(x));`);
  await check("FAQ: clicking a question toggles its answer", `const items = t.qa('faq-item'); if (items.length !== 3) return false;
    t.q('faq-question', items[1]).click();
    const shown = await t.until(() => t.vis(t.q('faq-answer', items[1])));
    const others = !t.vis(t.q('faq-answer', items[0])) && !t.vis(t.q('faq-answer', items[2]));
    t.q('faq-question', items[1]).click();
    const hidden = await t.until(() => !t.vis(t.q('faq-answer', items[1])));
    return shown && others && hidden || {shown, others, hidden};`);

  // ---- footer ----
  await check("FOOTER: copyright with current year", `const f = t.q('site-footer'); const c = t.q('copyright');
    const want = '© ' + new Date().getFullYear() + ' Orbitly. All rights reserved.';
    return !!f && f.tagName === 'FOOTER' && !!c && f.contains(c) && t.txt(c) === want || t.txt(c);`);
  {
    // Year must be computed at runtime: fake a different clock before any page script runs.
    const name = "FOOTER: year computed at runtime";
    try {
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `
        (() => { const Real = Date; const shift = Date.UTC(2041, 5, 15) - Real.now();
          class FakeDate extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); }
            static now() { return Real.now() + shift; } }
          globalThis.Date = FakeDate; })();` });
      await load();
      const txt = await evaluate(`window.__t.txt(window.__t.q('copyright'))`);
      results[name] = txt === "© 2041 Orbitly. All rights reserved.";
      if (!results[name]) notes[name] = J(txt);
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    } catch (e) { results[name] = false; notes[name] = String(e.message || e); }
  }
}

const hardTimeout = setTimeout(() => { console.log(J({ results, notes, error: "hard timeout" })); cleanup(); process.exit(0); }, 120000);
try {
  await main();
  console.log(J({ results, notes }));
} catch (e) {
  console.log(J({ results, notes, error: String(e && e.stack || e) }));
} finally {
  clearTimeout(hardTimeout);
  try { ws?.close(); } catch {}
  cleanup();
  process.exit(0);
}
