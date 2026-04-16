import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
};

function normalizeMetadata(
  value: unknown,
): string | Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

type FeedbackInput = {
  kind: string;
  action?: string;
  pushId?: string;
  intentCardId?: string;
  intentKey?: string;
  conversationId?: string;
  messageId?: string;
  source?: string;
  basket?: string;
  channel?: string;
  value?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  at?: string;
};

const OUTCOME_BY_FEEDBACK: Record<string, "confirm" | "modify" | "dismiss" | "snooze" | undefined> = {
  "card_action:confirm": "confirm",
  "card_action:modify": "modify",
  dismiss: "dismiss",
  snooze: "snooze",
};

async function enrichFeedbackInput(input: FeedbackInput): Promise<FeedbackInput> {
  const metadata = input.metadata ? { ...input.metadata } : undefined;
  let intentKey = metadata && typeof metadata.intentKey === 'string' ? metadata.intentKey : input.intentKey;
  let basket = input.basket;

  if ((!intentKey || !basket) && input.intentCardId) {
    const card = await db.getRecentGeneratedCardByCardId(input.intentCardId);
    if (card) {
      intentKey = intentKey ?? card.intentKey;
      basket = basket ?? card.goalBasket ?? undefined;
    }
  }

  if (intentKey) {
    if (metadata) {
      metadata.intentKey = intentKey;
    } else {
      return {
        ...input,
        basket,
        intentKey,
        metadata: { intentKey },
      };
    }
  }

  return {
    ...input,
    basket,
    intentKey,
    metadata,
  };
}

export function handleFeedback(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/feedback' || ctx.req.method !== 'POST') return false;
    try {
      const body = await readBody(ctx.req);
      const kind = asTrimmedString(body['kind']) ?? '';
      if (!kind) { json(ctx.res, 400, { error: 'Missing kind' }); return true; }
      const metadata = normalizeMetadata(body['metadata']);
      const input = await enrichFeedbackInput({
        kind,
        action: asTrimmedString(body['action']) ?? undefined,
        pushId: asTrimmedString(body['pushId']) ?? undefined,
        intentCardId: asTrimmedString(body['intentCardId']) ?? undefined,
        intentKey: undefined,
        conversationId: asTrimmedString(body['conversationId']) ?? undefined,
        messageId: asTrimmedString(body['messageId']) ?? undefined,
        source: asTrimmedString(body['source']) ?? 'user_direct',
        basket: asTrimmedString(body['basket']) ?? undefined,
        channel: asTrimmedString(body['channel']) ?? undefined,
        value: asTrimmedString(body['value']) ?? undefined,
        text: asTrimmedString(body['text']) ?? undefined,
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
        at: asTrimmedString(body['at']) ?? undefined,
      });
      const record = await db.logFeedback(input);
      const outcomeKey = input.kind === 'card_action' && input.action
        ? `${input.kind}:${input.action}`
        : input.kind;
      const outcome = OUTCOME_BY_FEEDBACK[outcomeKey];
      if (outcome && input.intentCardId && input.intentKey && input.basket) {
        await db.applyCardOutcome({
          cardId: input.intentCardId,
          intentKey: input.intentKey,
          goalBasket: input.basket,
          outcome,
          at: input.at,
        });
      }
      json(ctx.res, 200, { ok: true, data: record });
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
