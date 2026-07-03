import type { ConversationHistoryPage } from "@pin-ai/core";

export function startSync(_userId: string): void {
  // Web preview does not run the durable Expo SQLite sync loop.
}

export function stopSync(): void {
  // No local sync scheduler in Web preview.
}

export function notifyThreadActivity(_threadId: string): void {
  // No local sync scheduler in Web preview.
}

export async function readLocalHistory(
  _threadId: string,
  _limit = 200,
): Promise<ConversationHistoryPage | null> {
  return null;
}

export async function enqueueFeedback(
  _body: unknown,
  _dedupeKey?: string,
): Promise<boolean> {
  return false;
}
