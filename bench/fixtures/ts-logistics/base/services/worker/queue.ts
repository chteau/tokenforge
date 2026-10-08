export interface Job<T = Record<string, unknown>> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  runAt: number;
  lastError?: string;
}

/** In-process job queue with retry/backoff. Jobs run one at a time. */
export class JobQueue {
  private jobs: Job[] = [];
  private seq = 0;
  readonly dead: Job[] = [];
  private readonly maxAttempts: number;

  constructor(opts: { maxAttempts?: number } = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  enqueue(type: string, payload: Record<string, unknown> = {}, delayMs = 0): Job {
    this.seq += 1;
    const job: Job = { id: `job_${this.seq}`, type, payload, attempts: 0, runAt: Date.now() + delayMs };
    this.jobs.push(job);
    return job;
  }

  size(): number {
    return this.jobs.length;
  }

  next(now = Date.now()): Job | undefined {
    const idx = this.jobs.findIndex((j) => j.runAt <= now);
    if (idx < 0) return undefined;
    return this.jobs.splice(idx, 1)[0];
  }

  retry(job: Job, err: unknown): void {
    job.attempts += 1;
    job.lastError = String(err instanceof Error ? err.message : err);
    if (job.attempts >= this.maxAttempts) {
      this.dead.push(job);
      return;
    }
    job.runAt = Date.now() + Math.min(60_000, 250 * 2 ** job.attempts);
    this.jobs.push(job);
  }
}
