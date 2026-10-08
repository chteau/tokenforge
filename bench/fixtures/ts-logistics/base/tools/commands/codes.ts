import { CARRIER_SERVICE_CODES } from '../../packages/carriers/src/index.ts';
import { parseFlags } from '../cli.ts';

export async function runCodes(args: string[], out: (l: string) => void): Promise<number> {
  const { flags } = parseFlags(args);
  const rows = CARRIER_SERVICE_CODES.filter(
    (r) =>
      (!flags.carrier || r.carrier === flags.carrier) &&
      (!flags.service || r.service === flags.service) &&
      (!flags.kind || r.kind === flags.kind) &&
      (flags.all || r.active),
  );
  for (const r of rows) out(`${r.externalCode.padEnd(28)} ${String(r.legacyCode).padEnd(6)} ${r.active ? '' : '(inactive)'}`.trimEnd());
  out(`${rows.length} codes`);
  return 0;
}
