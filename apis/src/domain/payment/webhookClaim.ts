import Stripe from "stripe";

const extractTelegramUserId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;

  const obj = payload as any;

  // 优先从 metadata 提取
  const metadata = obj.metadata;
  let telegramUserId =
    typeof metadata?.telegram_user_id === "string"
      ? metadata.telegram_user_id.trim()
      : "";

  if (telegramUserId) return telegramUserId;

  // 对于 Invoice：从 parent.subscription_details.metadata 提取
  const parentMeta = obj.parent?.subscription_details?.metadata;
  if (parentMeta?.telegram_user_id) {
    telegramUserId = parentMeta.telegram_user_id.trim();
    if (telegramUserId) return telegramUserId;
  }

  // 对于 Invoice：从 lines[0].metadata 提取
  const firstLine = obj.lines?.data?.[0];
  if (firstLine?.metadata?.telegram_user_id) {
    telegramUserId = firstLine.metadata.telegram_user_id.trim();
    if (telegramUserId) return telegramUserId;
  }

  return undefined;
};

const extractAssistantId = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== "object") return undefined;

  const obj = payload as any;

  // 从 metadata 提取
  const metadata = obj.metadata;
  let assistantId = metadata?.assistant_id;

  // 尝试解析为数字
  if (typeof assistantId === "string") {
    const parsed = Number.parseInt(assistantId, 10);
    if (Number.isFinite(parsed)) return parsed;
  } else if (typeof assistantId === "number" && Number.isFinite(assistantId)) {
    return Math.trunc(assistantId);
  }

  // 对于 Invoice：从 parent.subscription_details.metadata 提取
  const parentMeta = obj.parent?.subscription_details?.metadata;
  if (parentMeta?.assistant_id) {
    assistantId = parentMeta.assistant_id;
    if (typeof assistantId === "string") {
      const parsed = Number.parseInt(assistantId, 10);
      if (Number.isFinite(parsed)) return parsed;
    } else if (
      typeof assistantId === "number" &&
      Number.isFinite(assistantId)
    ) {
      return Math.trunc(assistantId);
    }
  }

  // 对于 Invoice：从 lines[0].metadata 提取
  const firstLine = obj.lines?.data?.[0];
  if (firstLine?.metadata?.assistant_id) {
    assistantId = firstLine.metadata.assistant_id;
    if (typeof assistantId === "string") {
      const parsed = Number.parseInt(assistantId, 10);
      if (Number.isFinite(parsed)) return parsed;
    } else if (
      typeof assistantId === "number" &&
      Number.isFinite(assistantId)
    ) {
      return Math.trunc(assistantId);
    }
  }

  return undefined;
};

const extractAmount = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.amount_total,
    record.amount_paid,
    record.amount_due,
    record.amount,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return Math.trunc(candidate);
  }
  return undefined;
};

const extractCurrency = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.currency === "string" ? record.currency : undefined;
};

const extractStatus = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.status === "string") return record.status;
  if (typeof record.payment_status === "string") return record.payment_status;
  return undefined;
};

export interface StripeEventClaimPayload {
  stripe_event_id: string;
  event_type: string;
  raw_data: unknown;
  telegram_user_id?: string;
  assistant_id?: number;
  amount?: number;
  currency?: string;
  status?: string;
}

export const buildStripeEventClaimPayload = (
  event: Stripe.Event,
): StripeEventClaimPayload => {
  const eventObject = event.data.object;
  const claimPayload: StripeEventClaimPayload = {
    stripe_event_id: event.id.trim(),
    event_type: event.type.trim(),
    raw_data: eventObject,
  };

  const telegramUserId = extractTelegramUserId(eventObject);
  const assistantId = extractAssistantId(eventObject);
  const amount = extractAmount(eventObject);
  const currency = extractCurrency(eventObject);
  const status = extractStatus(eventObject);

  if (telegramUserId) claimPayload.telegram_user_id = telegramUserId;
  if (assistantId !== undefined) claimPayload.assistant_id = assistantId;
  if (amount !== undefined) claimPayload.amount = amount;
  if (currency !== undefined) claimPayload.currency = currency;
  if (status !== undefined) claimPayload.status = status;

  return claimPayload;
};
