/**
 * Shared admission control for one upstream API: at most `concurrency` requests in flight,
 * started no faster than `ratePerSec` (bursting to `burst`). Every user's calls leave from
 * the same server IP, so this is the server's whole footprint on that API. Callers wait
 * for a slot instead of failing, but never longer than `maxWaitMs`; a 429 pauses new
 * starts so concurrent callers back off together.
 */
export class UpstreamGate {
  private active = 0;
  private tokens: number;
  private updatedAt = Date.now();
  private pausedUntil = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  private wake?: NodeJS.Timeout;

  constructor(
    private readonly opts: { concurrency: number; ratePerSec: number; burst: number; maxWaitMs: number },
  ) {
    this.tokens = opts.burst;
  }

  /**
   * Resolves with a release function once the request may start. Rejects with AbortError if
   * `signal` aborts while queued, and immediately if the gate is paused for longer than maxWaitMs
   * (an upstream told us not to call before then; queueing would only delay the failure).
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('aborted while waiting for an upstream slot'), { name: 'AbortError' }));
      const pausedFor = this.pausedUntil - Date.now();
      if (pausedFor > this.opts.maxWaitMs) {
        return reject(Object.assign(new Error(`upstream asked us to wait ${Math.ceil(pausedFor / 1000)}s`), { name: 'Paused', retryAfterMs: pausedFor }));
      }
      const waiter = {
        resolve: (release: () => void) => { signal?.removeEventListener('abort', onAbort); resolve(release); },
        reject,
        timer: setTimeout(() => {
          remove();
          reject(new Error(`waited ${this.opts.maxWaitMs}ms for an upstream slot`));
        }, this.opts.maxWaitMs),
      };
      const remove = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
        // The wake timer exists only for waiters; with none left it must not keep the process alive.
        if (!this.queue.length && this.wake) { clearTimeout(this.wake); this.wake = undefined; }
      };
      const onAbort = () => {
        clearTimeout(waiter.timer);
        remove();
        reject(Object.assign(new Error('aborted while waiting for an upstream slot'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.timer.unref?.();
      this.queue.push(waiter);
      this.drain();
    });
  }

  /** No request in flight or queued, and not paused: safe to forget this gate. */
  idle(): boolean {
    return this.active === 0 && this.queue.length === 0 && this.pausedUntil <= Date.now();
  }

  /** Milliseconds until the gate admits requests again after a pause (0 if not paused). */
  pausedForMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Stop starting requests for `ms` (an upstream 429 asked us to slow down). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    // Resume at the steady rate: no burst accrues while paused, so the pause does not
    // end with `concurrency` requests hitting the API that just throttled us.
    this.tokens = Math.min(this.tokens, 1);
    this.updatedAt = Math.max(this.updatedAt, this.pausedUntil);
    this.drain();
  }

  private drain(): void {
    while (this.queue.length && this.active < this.opts.concurrency) {
      const now = Date.now();
      // updatedAt sits in the future during a pause; accrue nothing until it passes.
      if (now > this.updatedAt) {
        this.tokens = Math.min(this.opts.burst, this.tokens + ((now - this.updatedAt) / 1000) * this.opts.ratePerSec);
        this.updatedAt = now;
      }
      const waitMs = Math.max(
        this.pausedUntil - now,
        this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.opts.ratePerSec) * 1000,
      );
      if (waitMs > 0) {
        if (!this.wake) {
          // Not unref'd: a caller is waiting on this timer, so the process must stay alive for it
          // (a script or MCPB host with nothing else pending would otherwise exit mid-request).
          this.wake = setTimeout(() => { this.wake = undefined; this.drain(); }, Math.ceil(waitMs));
        }
        return;
      }
      this.tokens -= 1;
      this.active++;
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
