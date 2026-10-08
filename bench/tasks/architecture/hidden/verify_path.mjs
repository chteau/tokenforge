#!/usr/bin/env node
// Development check for the architecture task ground truth (not used by evaluate.py).
//
//   node tasks/architecture/hidden/verify_path.mjs <repo-root>
//
// Instruments every ground-truth and decoy function at load time (a trace
// call is injected at the top of each function body), boots the real gateway
// via services/gateway/main.ts:start, sends a quote request for a remote
// postcode over HTTP and asserts:
//   1. the response carries the RAS line item and the quote is persisted,
//   2. every ground-truth function ran, in ground-truth order,
//   3. no decoy function ran,
//   4. control: for a contract tenant zoneUplift is NOT reached and no RAS appears,
//   5. control: with features.zoneEngineV2 on, zoneUpliftV2 replaces zoneUplift.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const truth = JSON.parse(readFileSync(new URL('./ground_truth.json', import.meta.url), 'utf8'));
const targets = new Map(); // abs path -> [{label, symbol}]
const add = (rel, symbol, kind) => {
  const abs = join(repo, rel);
  const list = targets.get(abs) ?? [];
  list.push({ label: `${kind}:${rel}:${symbol}`, symbol });
  targets.set(abs, list);
};
truth.path.forEach(([rel, sym]) => add(rel, sym, 'path'));
truth.decoys.forEach(([rel, sym]) => add(rel, sym, 'decoy'));

function instrument(src, symbol, label, file) {
  const re = new RegExp(`(?:function\\s+${symbol}\\s*\\(|^[ \\t]*(?:export\\s+)?(?:async\\s+)?${symbol}\\s*\\()`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`symbol ${symbol} not found in ${file}`);
  let i = m.index + m[0].length; // just after '('
  let depth = 1;
  while (depth > 0 && i < src.length) {
    const ch = src[i++];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  const brace = src.indexOf('{', i);
  if (brace < 0) throw new Error(`no body for ${symbol} in ${file}`);
  return src.slice(0, brace + 1) + `globalThis.__pathTrace?.push(${JSON.stringify(label)});` + src.slice(brace + 1);
}

const instrumented = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:')) return result;
    const file = fileURLToPath(url);
    const list = targets.get(file);
    if (!list) return result;
    let src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    for (const t of list) {
      src = instrument(src, t.symbol, t.label, file);
      instrumented.add(t.label);
    }
    return { ...result, source: src };
  },
});

// Force-load decoy modules too, so a missing decoy symbol is reported.
globalThis.__pathTrace = [];
for (const abs of targets.keys()) await import(pathToFileURL(abs).href);
const allLabels = [...targets.values()].flat().map((t) => t.label);
const notInstrumented = allLabels.filter((l) => !instrumented.has(l));
if (notInstrumented.length) throw new Error(`not instrumented: ${notInstrumented.join(', ')}`);

const { start } = await import(pathToFileURL(join(repo, 'services/gateway/main.ts')).href);
const { silentLogger } = await import(pathToFileURL(join(repo, 'packages/core/src/index.ts')).href);

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

async function scenario(name, { key, overrides = {}, postcode = 'HS1 2AB' }) {
  globalThis.__pathTrace = [];
  const g = await start({ root: repo, env: 'test', logger: silentLogger, overrides });
  try {
    const res = await fetch(`${g.url}/v2/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        origin: { country: 'GB', postcode: 'B1 1AA' },
        destination: { country: 'GB', postcode },
        parcels: [{ weightGrams: 2500 }],
        service: 'standard',
      }),
    });
    const body = await res.json();
    const stored = g.container.get('core.store').find('quotes', body.id);
    return { name, status: res.status, body, stored, trace: [...globalThis.__pathTrace] };
  } finally {
    await g.stop();
  }
}

// --- main scenario --------------------------------------------------------
const main = await scenario('remote postcode, standard tenant', { key: 'kf_live_acme_7f3e' });
console.log('trace:', main.trace.join('\n       '));
const ras = main.body.lineItems?.find((l) => l.code === 'RAS');
check(main.status === 201, 'quote created (201)');
check(Boolean(ras) && ras.label === 'Remote area surcharge', `RAS line present (${JSON.stringify(ras)})`);
check(ras && ras.amount === Math.round(main.body.lineItems[0].amount * 0.035), 'RAS amount is 3.5% of base');
check(main.stored?.lineItems?.some((l) => l.code === 'RAS'), 'persisted quote contains RAS');
const pathLabels = truth.path.map(([rel, sym]) => `path:${rel}:${sym}`);
const firstIdx = pathLabels.map((l) => main.trace.indexOf(l));
pathLabels.forEach((l, k) => check(firstIdx[k] >= 0, `executed ${l}`));
check(firstIdx.every((v, k) => k === 0 || v > firstIdx[k - 1]), 'ground-truth steps executed in order');
const decoysRun = main.trace.filter((l) => l.startsWith('decoy:'));
check(decoysRun.length === 0, `no decoy executed ${decoysRun.length ? decoysRun.join(', ') : ''}`);
// zoneUplift must be the producer: last path step before save is zoneUplift
const zi = main.trace.indexOf('path:packages/rates/src/adjustments.ts:zoneUplift');
const si = main.trace.indexOf('path:packages/shipping/src/quotes/QuoteRepository.ts:save');
check(zi >= 0 && si > zi, 'zoneUplift runs before the repository write');

// --- control: contract tenant ---------------------------------------------
const contract = await scenario('remote postcode, contract tenant', { key: 'kf_live_fjord_19aa' });
check(!contract.body.lineItems.some((l) => l.code === 'RAS'), 'contract tenant: no RAS line');
check(!contract.trace.includes('path:packages/rates/src/adjustments.ts:zoneUplift'), 'contract tenant: zoneUplift not reached');
check(contract.trace.includes('path:services/gateway/middleware/tenant.ts:resolveTenant'), 'contract tenant: profile chosen in resolveTenant');

// --- control: flag on -----------------------------------------------------
const flagged = await scenario('zoneEngineV2 enabled', { key: 'kf_live_acme_7f3e', overrides: { features: { zoneEngineV2: true } } });
check(flagged.trace.includes('decoy:packages/rates/src/zones/zoneEngineV2.ts:zoneUpliftV2'), 'flag on: zoneUpliftV2 runs');
check(!flagged.trace.includes('path:packages/rates/src/adjustments.ts:zoneUplift'), 'flag on: zoneUplift does not run');

console.log(failures ? `\n${failures} check(s) failed` : '\nGROUND TRUTH VERIFIED');
process.exit(failures ? 1 : 0);
