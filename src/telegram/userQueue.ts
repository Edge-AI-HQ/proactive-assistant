export type QueuedTask = () => Promise<void>;

export class TelegramUserQueue {
  private readonly queues = new Map<number, Promise<void>>();

  async enqueue(telegramUserId: number, task: QueuedTask): Promise<void> {
    const current = this.queues.get(telegramUserId) ?? Promise.resolve();
    const next = current.catch(() => undefined).then(task);
    this.queues.set(telegramUserId, next);

    try {
      await next;
    } finally {
      if (this.queues.get(telegramUserId) === next) {
        this.queues.delete(telegramUserId);
      }
    }
  }
}
