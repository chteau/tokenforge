/**
 * tmap Client - Interface to tmap CLI for context packs
 * Provides programmatic access to tmap queries
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMAP_BIN = path.join(__dirname, '..', 'bin', 'tmap');

/**
 * Execute tmap command and parse JSON output
 */
function runTmap(args, cwd = process.cwd()) {
  const result = spawnSync(TMAP_BIN, args, { cwd, encoding: 'utf8', timeout: 10000 });
  
  if (result.error) {
    throw new Error(`tmap execution failed: ${result.error.message}`);
  }
  
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    if (stderr.includes('not indexed') || stderr.includes('no matches')) {
      return null; // Not an error, just no results
    }
    throw new Error(`tmap failed (${result.status}): ${stderr}`);
  }
  
  const stdout = result.stdout?.toString() || '';
  if (!stdout.trim()) return null;
  
  try {
    return JSON.parse(stdout);
  } catch {
    // Some tmap commands output plain text
    return stdout.trim();
  }
}

/**
 * Find symbols by name
 */
export async function queryGraph(queryType, target, options = {}) {
  const cwd = options.cwd || process.cwd();
  const args = [];
  
  switch (queryType) {
    case 'callers':
      args.push('callers', target);
      break;
    case 'callees':
      args.push('callees', target);
      break;
    case 'exports':
      args.push('sym', target); // tmap sym shows exports
      break;
    case 'find':
      args.push('find', target);
      break;
    case 'symbol':
      args.push('sym', target);
      break;
    default:
      throw new Error(`Unknown query type: ${queryType}`);
  }
  
  if (options.json) args.push('--json');
  
  return runTmap(args, cwd);
}

/**
 * Get file outline
 */
export async function getFileOutline(filePath, cwd = process.cwd()) {
  return runTmap(['tree', filePath], cwd);
}

/**
 * Get symbol slice (line range)
 */
export async function getSymbolSlice(symbol, cwd = process.cwd()) {
  return runTmap(['slice', symbol], cwd);
}

/**
 * Search for symbol definitions
 */
export async function findSymbol(symbol, cwd = process.cwd()) {
  const result = await runTmap(['sym', symbol, '--json'], cwd);
  if (!result) return [];
  
  // Parse tmap sym output: "path:start-end  signature"
  if (typeof result === 'string') {
    return result.split('\n').filter(Boolean).map(line => {
      const match = line.match(/^(.+):(\d+)-(\d+)\s+(.+)$/);
      if (match) {
        return { file: match[1], start: parseInt(match[2]), end: parseInt(match[3]), signature: match[4] };
      }
      return { raw: line };
    });
  }
  return result;
}

/**
 * Get callers of a symbol
 */
export async function getCallers(symbol, cwd = process.cwd()) {
  const result = await runTmap(['callers', symbol, '--json'], cwd);
  if (!result) return [];
  
  if (typeof result === 'string') {
    return result.split('\n').filter(Boolean).map(line => {
      // Format: "file:line  symbol"
      const match = line.match(/^(.+):(\d+)\s+(.+)$/);
      if (match) {
        return { file: match[1], line: parseInt(match[2]), symbol: match[3] };
      }
      return { raw: line };
    });
  }
  return result;
}

/**
 * Get all indexed files
 */
export async function getIndexedFiles(cwd = process.cwd()) {
  const result = await runTmap(['tree', '--json'], cwd);
  return result || [];
}

export { runTmap };