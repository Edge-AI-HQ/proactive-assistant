import { readErrorMessage } from "../transport/errors";
import { proxyPost } from "../transport/http";

export async function recordCardOpen(
  cardId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const res = await proxyPost(
    `/reward-dashboard/cards/${encodeURIComponent(cardId)}/score`,
    {
      source: "user",
      eventType: "card_open",
      score: 1,
      metadata,
    },
  );
  if (!res.ok) {
    throw new Error(`/reward-dashboard card_open failed: ${await readErrorMessage(res)}`);
  }
}
