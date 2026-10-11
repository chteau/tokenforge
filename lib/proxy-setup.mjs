// The proxy on by default: Claude Code reaches it through ANTHROPIC_BASE_URL in the user settings' env, set once
// (the first session after install) and recorded in tokenforge's config, so `tforge proxy off` removes exactly that.
// Claude Code reads the setting when a session starts and keeps it: if the proxy is down, every request fails. So
// the hooks keep it up (session start, every prompt, after every tool call) and the setting is only written once
// the proxy answered on its port. Never set when the user already routes requests elsewhere (their own
// ANTHROPIC_BASE_URL, Bedrock, Vertex, Foundry). Off for good: TFORGE_PROXY=0 before the first session, or
// `tforge proxy off`. The proxy only listens on 127.0.0.1.
import { readConfig, writeConfig } from './config.mjs';
import { readSettings, settingsFile, writeSettings } from './lean.mjs';
import { daemonStart, daemonState } from './ui-control.mjs';

export const DEFAULT_PORT = 7879;
export const proxyPort = () => Number(process.env.TFORGE_PROXY_PORT) || DEFAULT_PORT;
export const proxyUrl = (port = proxyPort()) => `http://127.0.0.1:${port}`;
const PROVIDERS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const truthy = (v) => !!v && !/^(0|false|no|off)$/i.test(String(v));

// Why the proxy must not be set up here; null when it can.
export function proxyBlocked(file = settingsFile(), env = process.env) {
  const s = readSettings(file);
  const added = readConfig().proxyAdded;
  const own = [s.env?.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL].find((u) => u && u !== added);
  if (own) return `requests already go to ${own}`;
  const p = PROVIDERS.find((k) => truthy(s.env?.[k]) || truthy(env[k]));
  return p ? `${p} is set` : null;
}

// The URL tokenforge set and the settings still hold, or null.
export function proxyWanted(file = settingsFile()) {
  const added = readConfig().proxyAdded;
  try {
    return added && readSettings(file).env?.ANTHROPIC_BASE_URL === added ? added : null;
  } catch {
    return null;
  }
}

export function proxyStatus(file = settingsFile()) {
  const url = proxyWanted(file);
  const st = daemonState('proxy');
  return { on: !!url, url, running: st ? { port: st.port, pid: st.pid } : null, file };
}

// Start the daemon on the port `url` names unless it already runs there. Resolves to the state or null.
export async function ensureProxyDaemon(url = proxyWanted()) {
  if (!url) return null;
  const port = Number(new URL(url).port);
  const st = daemonState('proxy');
  if (st && st.port === port) return st;
  if (st) return null; // running on another port: someone started it by hand, leave it
  return daemonStart('proxy', { port, detach: true });
}

// Route Claude Code through the proxy: start it, and only once it answers, write the setting.
export async function proxyOn(file = settingsFile(), { port = proxyPort(), explicit = true } = {}) {
  if (explicit) writeConfig({ proxyDefaultDone: true });
  const blocked = proxyBlocked(file);
  if (blocked) return { ok: false, reason: blocked };
  const url = proxyUrl(port);
  const st = await ensureProxyDaemon(url);
  if (!st) return { ok: false, reason: `the proxy did not start on 127.0.0.1:${port} (see ~/.cache/tokenforge/proxy.log)` };
  const s = readSettings(file);
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: url };
  writeSettings(file, s);
  writeConfig({ proxyAdded: url, proxyDefaultDone: true });
  return { ok: true, url };
}

// Remove the setting tokenforge added (never the user's own). The daemon keeps running for sessions still using it.
export function proxyOff(file = settingsFile()) {
  writeConfig({ proxyDefaultDone: true });
  const added = readConfig().proxyAdded;
  const s = readSettings(file);
  let removed = false;
  if (added && s.env?.ANTHROPIC_BASE_URL === added) {
    delete s.env.ANTHROPIC_BASE_URL;
    if (!Object.keys(s.env).length) delete s.env;
    writeSettings(file, s);
    removed = true;
  }
  writeConfig({ proxyAdded: null });
  return { removed };
}

// First session: turn the proxy on once. Any explicit choice (tforge proxy on|off) marks it done.
export async function applyProxyDefaultOnce(file = settingsFile()) {
  if (readConfig().proxyDefaultDone) return null;
  if (!truthy(process.env.TFORGE_PROXY ?? '1')) {
    writeConfig({ proxyDefaultDone: true });
    return null;
  }
  const r = await proxyOn(file, { explicit: false });
  // a failed start is retried in the next two sessions; anything else (blocked, or done) is final
  const tries = (readConfig().proxyDefaultTries || 0) + 1;
  if (r.ok || !/did not start/.test(r.reason) || tries >= 3) writeConfig({ proxyDefaultDone: true });
  else writeConfig({ proxyDefaultTries: tries });
  return r.ok ? r : null;
}

// Hooks call this before requests go out (session start, each prompt, after each tool call): restart the proxy if
// it died. A file read and a signal-0 when it runs. Returns a warning for the user when it cannot be brought back.
export async function proxyGuard(file = settingsFile()) {
  const url = proxyWanted(file);
  if (!url || (await ensureProxyDaemon(url))) return null;
  return `tokenforge: the proxy at ${url} is down and did not restart (see ~/.cache/tokenforge/proxy.log), so Claude Code's requests fail. Start it with \`tforge proxy --detach\`, or remove it with \`tforge proxy off\` and start a new session.`;
}
