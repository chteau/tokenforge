import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router, loadConfig, findRoot, type AppConfig, type Container, type Logger } from '../../packages/core/src/index.ts';
import { buildContainer } from './bootstrap.ts';
import { mountRoutes } from './routes/index.ts';
import { createHttpServer } from './server.ts';

export interface StartOptions {
  root?: string;
  env?: string;
  overrides?: Record<string, unknown>;
  logger?: Logger;
  services?: (c: Container) => void;
}

export interface Gateway {
  server: Server;
  url: string;
  config: AppConfig;
  container: Container;
  stop(): Promise<void>;
}

/** Boots the HTTP gateway: config, service container, routes, listener. */
export async function start(opts: StartOptions = {}): Promise<Gateway> {
  const root = opts.root ?? findRoot(process.cwd());
  const config = loadConfig({ root, env: opts.env, overrides: opts.overrides });
  const container = buildContainer(config, { root, logger: opts.logger, overrides: opts.services });
  container.get<{ attach(): void }>('notify.notifier').attach();

  const router = mountRoutes(new Router(), container, config);
  const server = createHttpServer(router, container, { bodyLimit: config.http.bodyLimit });
  await new Promise<void>((resolve) => server.listen(config.http.port, config.http.host, resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`;
  container.get<Logger>('core.logger').info('gateway listening', { url, env: config.env });
  return {
    server,
    url,
    config,
    container,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

if (import.meta.main) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
