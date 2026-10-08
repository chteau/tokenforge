import { join } from 'node:path';
import { JsonlStore, findRoot, loadConfig } from '../../packages/core/src/index.ts';
import { loadAccounts } from '../../packages/core/src/tenant/resolveTenant.ts';
import { quoteWithTariff } from '../../packages/legacy/tariff/quoteWithTariff.ts';
import { QuoteRepository } from '../../packages/legacy/quotes/QuoteRepository.ts';
import { parseFlags } from '../cli.ts';

/** Offline quote for the sales desk, priced on the account's frozen tariff. */
export async function runQuote(args: string[], out: (l: string) => void): Promise<number> {
  const { flags } = parseFlags(args);
  const account = String(flags.account ?? '');
  const kg = Number(flags.kg);
  const postcode = String(flags.postcode ?? '');
  if (!account || !Number.isFinite(kg) || !postcode) {
    out('quote: --account, --kg and --postcode are required');
    return 2;
  }
  const root = findRoot(process.cwd());
  const accounts = loadAccounts(join(root, 'config', 'accounts.legacy.json'));
  const acct = accounts.find((a) => a.account === account);
  if (!acct) {
    out(`quote: unknown account ${account}`);
    return 1;
  }
  const q = quoteWithTariff({ account, tariff: acct.tariff, weightKg: kg, postcode, outOfHours: flags['out-of-hours'] === true });
  for (const l of q.lines) out(`${l.code.padEnd(4)} ${l.text.padEnd(24)} ${(l.pence / 100).toFixed(2).padStart(8)}`);
  out(`${'TOTAL'.padEnd(29)} ${(q.totalPence / 100).toFixed(2).padStart(8)}`);
  if (flags.save) {
    const config = loadConfig({ root });
    const id = new QuoteRepository(new JsonlStore(config.storage.dataDir)).save(q);
    out(`saved ${id}`);
  }
  return 0;
}
