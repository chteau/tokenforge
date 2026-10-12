// Claude Code does not tell a plugin it was disabled, so the settings tokenforge wrote (ANTHROPIC_BASE_URL, lean's
// deny list, skill overrides, autoCompactWindow) would stay and keep acting. The proxy daemon still sees requests, so
// it checks: once enabledPlugins says tokenforge@… is false, it removes what tokenforge added (never the user's own)
// and remembers it, and the next session-start after re-enabling puts it back.
import { readConfig, writeConfig } from './config.mjs';
import { LEVELS, leanOff, leanOn, leanStatus, readSettings, settingsFile } from './lean.mjs';
import { proxyOff, proxyOn, proxyWanted } from './proxy-setup.mjs';

// true only when a tokenforge@… key exists and every such key is false: absent (e.g. --plugin-dir) is not disabled
export function pluginDisabled(file = settingsFile()) {
  const ep = readSettings(file).enabledPlugins;
  const keys = Object.keys(ep && typeof ep === 'object' ? ep : {}).filter((k) => /^tokenforge@/.test(k));
  return keys.length > 0 && keys.every((k) => ep[k] === false);
}

function oursPresent(file) {
  const c = readConfig();
  return !!(c.leanAdded?.length || c.skillsOffAdded?.length || c.leanGitAdded || c.leanWindowAdded || (c.proxyAdded && proxyWanted(file) === c.proxyAdded));
}

// Returns { lean, proxy } (what was removed) or null when there was nothing to do.
export function undoIfDisabled(file = settingsFile()) {
  if (!pluginDisabled(file) || !oursPresent(file)) return null;
  const c = readConfig();
  const level = leanStatus(file).level;
  const undo = { lean: LEVELS.includes(level) ? level : null, proxy: !!(c.proxyAdded && proxyWanted(file) === c.proxyAdded) };
  if (undo.proxy) proxyOff(file);
  leanOff(file);
  writeConfig({ disabledUndo: undo });
  return undo;
}

// Session start, so the plugin is enabled again: re-apply what undoIfDisabled removed, unless the user set it since.
export async function redoAfterReenable(file = settingsFile()) {
  const u = readConfig().disabledUndo;
  if (!u) return null;
  writeConfig({ disabledUndo: null });
  const done = [];
  if (u.lean && leanStatus(file).level === 'off') {
    leanOn(file, u.lean, { explicit: false });
    done.push(`lean tools ("${u.lean}")`);
  }
  if (u.proxy && !proxyWanted(file) && (await proxyOn(file, { explicit: false })).ok) done.push('the proxy');
  return done.length ? done : null;
}

// For the proxy's request handler: a settings read at most every `every` ms.
export function disabledWatcher(file = settingsFile(), every = 30e3) {
  let next = 0;
  return () => {
    const now = Date.now();
    if (now < next) return null;
    next = now + every;
    try {
      return undoIfDisabled(file);
    } catch {
      return null;
    }
  };
}
