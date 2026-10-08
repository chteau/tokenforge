import { findRoot, loadConfig } from '../../packages/core/src/index.ts';
import { classifyPostcode } from '../../packages/rates/src/index.ts';

export async function runZone(args: string[], out: (l: string) => void): Promise<number> {
  const [country, ...pc] = args;
  if (!country || pc.length === 0) {
    out('zone: usage: zone <country> <postcode>');
    return 2;
  }
  const config = loadConfig({ root: findRoot(process.cwd()) });
  const zone = classifyPostcode(country, pc.join(' '));
  const bps = config.rates.zoneUpliftBps[zone] ?? 0;
  out(`${country.toUpperCase()} ${pc.join(' ').toUpperCase()}: zone ${zone} (uplift ${(bps / 100).toFixed(2)}%)`);
  return 0;
}
