import { feedback as coreFeedback, memory as coreMemory, CoreError } from '../../../core/index.js';
import type { RouteContext } from '../types.js';
import { json, readBody } from '../http-utils.js';
import { buildDefaultCtx } from '../../pipeline/data-access.js';

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

const ctx = buildDefaultCtx();

const coreErrorToHttp = (
  res: import('node:http').ServerResponse,
  err: unknown,
): void => {
  if (err instanceof CoreError) {
    const status = err.type === 'not_found'
      ? 404
      : err.type === 'validation'
        ? 400
        : err.type === 'conflict'
          ? 409
          : 500;

    json(res, status, {
      ok: false,
      error: {
        type: err.type,
        code: err.code,
        message: err.message,
        hint: err.hint,
      },
    });
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  json(res, 500, { error: msg });
};

const normalizeMetadata = (
  value: unknown,
): string | Record<string, unknown> | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
};

const buildFeedbackInput = (body: Record<string, unknown>) => {
  const kind = asTrimmedString(body['kind']);
  if (!kind) {
    throw new Error('Missing kind');
  }

  return {
    kind,
    action: asTrimmedString(body['action']) ?? undefined,
    pushId: asTrimmedString(body['pushId']) ?? undefined,
    intentCardId: asTrimmedString(body['intentCardId']) ?? undefined,
    conversationId: asTrimmedString(body['conversationId']) ?? undefined,
    messageId: asTrimmedString(body['messageId']) ?? undefined,
    source: asTrimmedString(body['source']) ?? 'user_direct',
    basket: asTrimmedString(body['basket']) ?? undefined,
    channel: asTrimmedString(body['channel']) ?? undefined,
    value: asTrimmedString(body['value']) ?? undefined,
    text: asTrimmedString(body['text']) ?? undefined,
    metadata: normalizeMetadata(body['metadata']),
    at: asTrimmedString(body['at']) ?? undefined,
  };
};

const buildMemoryEventInput = (
  input: ReturnType<typeof buildFeedbackInput>,
): {
  profileId: string;
  source: string;
  kind: string;
  subjectType: string;
  subjectKey: string;
  text: string;
  payload: Record<string, unknown>;
  confidence: number;
  occurredAt?: string;
} => {
  const intentKey =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? asTrimmedString(input.metadata["intentKey"])
      : null;

  const subjectKey =
    intentKey
    ?? input.intentCardId
    ?? input.pushId
    ?? input.basket
    ?? input.kind;

  const memoryKind =
    input.action === "confirm"
      ? "user_confirmed"
      : input.kind === "dismiss"
        ? "user_dismissed"
        : input.kind === "snooze"
          ? "user_snoozed"
          : input.action === "modify"
            ? "user_modified"
            : "feedback_logged";

  const summaryText =
    input.text
    ?? [input.kind, input.action, input.basket, intentKey ?? input.intentCardId]
      .filter((value): value is string => Boolean(value))
      .join(" ");

  return {
    profileId: "default",
    source: "feedback",
    kind: memoryKind,
    subjectType: intentKey ? "intent" : (input.basket ? "basket" : "feedback"),
    subjectKey,
    text: summaryText || "feedback event",
    payload: {
      feedbackKind: input.kind,
      action: input.action ?? null,
      basket: input.basket ?? null,
      channel: input.channel ?? null,
      value: input.value ?? null,
      metadata: input.metadata ?? {},
    },
    confidence:
      input.action === "confirm"
        ? 1
        : input.kind === "dismiss"
          ? 0.9
          : 0.75,
    occurredAt: input.at,
  };
};

export async function handleFeedback(routeCtx: RouteContext): Promise<boolean> {
  if (routeCtx.subpath !== '/feedback' || routeCtx.req.method !== 'POST') return false;

  try {
    const body = await readBody(routeCtx.req);
    const input = buildFeedbackInput(body);
    const record = await coreFeedback.logFeedback(ctx, input);
    try {
      await coreMemory.recordMemoryEvent(ctx, buildMemoryEventInput(input));
    } catch {
      // Memory capture is best-effort and must not fail the primary feedback write.
    }

    json(routeCtx.res, 200, { ok: true, data: record });
  } catch (err) {
    if (err instanceof Error && err.message === 'Missing kind') {
      json(routeCtx.res, 400, { error: err.message });
    } else {
      coreErrorToHttp(routeCtx.res, err);
    }
  }
  return true;
}
