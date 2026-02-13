import type { Context } from 'grammy';

type MediaGroupEntry = {
  contexts: Context[];
  timer: NodeJS.Timeout;
};

export class TelegramMediaGroupBuffer {
  private readonly groups = new Map<string, MediaGroupEntry>();

  constructor(
    private readonly timeoutMs: number,
    private readonly onFlush: (contexts: Context[]) => Promise<void>
  ) {}

  add(mediaGroupId: string, ctx: Context): void {
    const existing = this.groups.get(mediaGroupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.contexts.push(ctx);
      existing.timer = this.createTimer(mediaGroupId);
      return;
    }

    this.groups.set(mediaGroupId, {
      contexts: [ctx],
      timer: this.createTimer(mediaGroupId)
    });
  }

  async flush(mediaGroupId: string): Promise<void> {
    const entry = this.groups.get(mediaGroupId);
    if (!entry) return;

    this.groups.delete(mediaGroupId);
    clearTimeout(entry.timer);
    await this.onFlush(entry.contexts);
  }

  private createTimer(mediaGroupId: string): NodeJS.Timeout {
    return setTimeout(() => {
      void this.flush(mediaGroupId);
    }, this.timeoutMs);
  }
}
