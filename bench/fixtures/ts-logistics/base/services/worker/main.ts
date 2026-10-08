import { findRoot, loadConfig, type Container, type Logger } from '../../packages/core/src/index.ts';
import { buildContainer } from '../gateway/bootstrap.ts';
import { JobQueue, type Job } from './queue.ts';
import { requoteExpired } from './jobs/requote.ts';
import { pollTracking } from './jobs/pollTracking.ts';
import { invoiceRun } from './jobs/invoiceRun.ts';
import { drainOutbox } from './jobs/drainOutbox.ts';

type JobHandler = (c: Container, payload: Record<string, unknown>) => Promise<unknown>;

export const HANDLERS: Record<string, JobHandler> = {
  'quotes.requote': (c, p) => requoteExpired(c, p as { tenantId: string }),
  'tracking.poll': (c) => pollTracking(c),
  'billing.invoiceRun': (c, p) => invoiceRun(c, p as { period?: string }),
  'notify.drain': (c) => drainOutbox(c),
};

export async function processOne(container: Container, queue: JobQueue, job: Job): Promise<void> {
  const handler = HANDLERS[job.type];
  const log = container.get<Logger>('core.logger');
  if (!handler) {
    log.warn('no handler for job', { type: job.type });
    return;
  }
  try {
    await handler(container, job.payload);
  } catch (err) {
    log.error('job failed', { id: job.id, type: job.type, err: String(err) });
    queue.retry(job, err);
  }
}

export async function drain(container: Container, queue: JobQueue, now = Date.now()): Promise<number> {
  let n = 0;
  for (let job = queue.next(now); job; job = queue.next(now)) {
    await processOne(container, queue, job);
    n += 1;
  }
  return n;
}

/** Worker entry point: schedules periodic jobs and processes the queue. */
export async function run(opts: { root?: string; env?: string; once?: boolean } = {}): Promise<{ container: Container; queue: JobQueue }> {
  const root = opts.root ?? findRoot(process.cwd());
  const config = loadConfig({ root, env: opts.env });
  const container = buildContainer(config, { root });
  container.get<{ attach(): void }>('notify.notifier').attach();
  const queue = new JobQueue();
  queue.enqueue('tracking.poll');
  queue.enqueue('notify.drain');
  if (new Date().getUTCDate() === config.billing.invoiceDay) queue.enqueue('billing.invoiceRun');
  if (opts.once) {
    await drain(container, queue);
    return { container, queue };
  }
  setInterval(() => {
    queue.enqueue('tracking.poll');
    queue.enqueue('notify.drain');
  }, config.tracking.pollIntervalMs);
  setInterval(() => void drain(container, queue), 1000);
  return { container, queue };
}

if (import.meta.main) {
  run({ once: process.argv.includes('--once') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
