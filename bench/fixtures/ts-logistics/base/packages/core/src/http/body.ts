import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';

export async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
    }
  }
  return text;
}
