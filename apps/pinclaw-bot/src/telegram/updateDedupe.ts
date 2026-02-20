import type { Context } from 'grammy';

const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;

class TimedDedupeCache {
  private readonly store = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number
  ) {}

  checkAndMark(key: string): boolean {
    const now = Date.now();
    this.prune(now);

    const existing = this.store.get(key);
    if (typeof existing === 'number' && now - existing <= this.ttlMs) {
      this.store.set(key, now);
      return true;
    }

    this.store.set(key, now);
    if (this.store.size > this.maxSize) {
      this.evictOldest(this.store.size - this.maxSize);
    }
    return false;
  }

  private prune(now: number): void {
    for (const [key, ts] of this.store) {
      if (now - ts > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  private evictOldest(count: number): void {
    if (count <= 0) return;
    const entries = Array.from(this.store.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < count; i += 1) {
      const item = entries[i];
      if (!item) break;
      this.store.delete(item[0]);
    }
  }
}

const dedupe = new TimedDedupeCache(RECENT_TELEGRAM_UPDATE_TTL_MS, RECENT_TELEGRAM_UPDATE_MAX);

const resolveUpdateId = (ctx: Context): number | undefined => {
  const update = ctx.update as { update_id?: unknown } | undefined;
  if (typeof update?.update_id === 'number') {
    return update.update_id;
  }
  return undefined;
};

const buildUpdateKey = (ctx: Context): string | null => {
  const updateId = resolveUpdateId(ctx);
  if (typeof updateId === 'number') {
    return `update:${updateId}`;
  }

  const callbackId = (ctx.update as { callback_query?: { id?: unknown } } | undefined)?.callback_query?.id;
  if (typeof callbackId === 'string' && callbackId.trim()) {
    return `callback:${callbackId}`;
  }

  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if ((typeof chatId === 'number' || typeof chatId === 'string') && typeof messageId === 'number') {
    return `message:${chatId}:${messageId}`;
  }

  return null;
};

export const shouldSkipDuplicateUpdate = (ctx: Context, namespace = 'default'): boolean => {
  const key = buildUpdateKey(ctx);
  if (!key) return false;
  return dedupe.checkAndMark(`${namespace}:${key}`);
};
