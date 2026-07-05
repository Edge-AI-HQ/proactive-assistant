import type { PersonalSignalInput } from "@/lib/devices";

export type FlushFn = (items: PersonalSignalInput[]) => Promise<void>;

export interface BufferOptions {
  /** Maximum items before forced flush. */
  maxItems?: number;
  /** Maximum age of the oldest item before forced flush (ms). */
  maxAgeMs?: number;
}

const DEFAULT_OPTS: Required<BufferOptions> = {
  // 方案 A (2026-07-01): 每个 source event 立即 flush → outbox → 立即 drain 上报,
  // 事件级实时。maxAgeMs 只作兜底。原来是 20 条 / 5s 批处理。
  maxItems: 1,
  maxAgeMs: 500,
};

/**
 * Time-or-count buffered queue for outgoing PersonalSignals.
 *
 * `flushFn` is the upload bridge (see `ingest-bridge.ts`). On failure
 * the batch is re-queued at the head so the next push or timer triggers
 * another attempt — there is no exponential backoff here on purpose;
 * the failure surface is small (HTTP 4xx/5xx + network), and the device
 * registration layer handles 401 by clearing the cached token.
 */
export class SignalBuffer {
  private items: PersonalSignalInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opts: Required<BufferOptions>;
  private flushing = false;

  constructor(
    private flushFn: FlushFn,
    opts: BufferOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  push(item: PersonalSignalInput): void {
    this.items.push(item);
    if (this.items.length >= this.opts.maxItems) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.opts.maxAgeMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.items.length === 0) return;
    if (this.flushing) return;
    this.flushing = true;
    const batch = this.items.splice(0, this.items.length);
    try {
      await this.flushFn(batch);
    } catch (err) {
      // Re-queue at the head so we retry on next push or external flush().
      this.items.unshift(...batch);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  size(): number {
    return this.items.length;
  }
}
