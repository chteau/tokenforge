import { createServer } from "node:http";
import type { AddressInfo } from "node:http";
import type { App } from "../app.ts";

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on `port` (0 = ephemeral) and resolve once the socket is bound. */
export function listen(app: App, options: { port?: number; host?: string } = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
