#!/usr/bin/env node
import { runQuote } from './commands/quote.ts';
import { runCodes } from './commands/codes.ts';
import { runZone } from './commands/zone.ts';
import { runTenants } from './commands/tenants.ts';

type Command = (args: string[], out: (line: string) => void) => Promise<number>;

export const COMMANDS: Record<string, { run: Command; help: string }> = {
  quote: { run: runQuote, help: 'quote --account <id> --kg <n> --postcode <pc> [--save]   offline tariff quote' },
  codes: { run: runCodes, help: 'codes [--carrier NWX] [--service express]                list carrier service codes' },
  zone: { run: runZone, help: 'zone <country> <postcode>                                 show the zone class for a postcode' },
  tenants: { run: runTenants, help: 'tenants                                                   list configured API tenants' },
};

export function parseFlags(args: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

export async function main(argv: string[], out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const [cmd, ...rest] = argv;
  const entry = cmd ? COMMANDS[cmd] : undefined;
  if (!entry) {
    out('usage: kestrel <command> [options]');
    for (const [name, c] of Object.entries(COMMANDS)) out(`  ${c.help.startsWith(name) ? c.help : `${name} ${c.help}`}`);
    return cmd ? 2 : 0;
  }
  return entry.run(rest, out);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
