import Stripe from "stripe";
import { db } from "./db.js";
import type { SubscriptionInfoByStripe } from "./paymentStoreCore.js";
import {
  syncLiteLLMBudgetAbsolute,
  syncLiteLLMBudgetFromPlan,
} from "./litellmBudget.js";
import { requireStripe } from "./stripeClient.js";
import {
  listAssistantsByOwnerTelegramId,
  getUserByTelegramId,
} from "../common/db/index.js";
import { config } from "../common/config.js";
import {
  stopAssistantContainer,
  ensureAssistantContainer,
} from "../container/index.js";
import { ensureLiteLLMKeyForAssistant } from "../litellm/index.js";
import { sendTelegramMessage } from "../telegram/notify.js";
import { createAssistantWithoutContainer } from "../claw-assistant/service.js";
import { shouldEnsureAssistantRuntime } from "../claw-assistant/runtimeHealth.js";

const parseUnixSecondsToDate = (value: unknown): Date | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
};

const isAssistantAlreadyExistsError = (error: unknown): boolean => {
  if (error instanceof Error && error.message === "USER_ALREADY_HAS_ASSISTANT") {
    return true;
  }

  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
};

const readSubscriptionPriceId = (
  subscription: Stripe.Subscription,
): string | null => {
  const firstItem = subscription.items.data[0];
  if (!firstItem) return null;
  return firstItem.price?.id || null;
};

const readInvoicePriceId = (invoice: Stripe.Invoice): string | null => {
  for (const line of invoice.lines.data) {
    if (line.price?.id) return line.price.id;
  }
  return null;
};

const resolvePlanCodeFromSubscription = async (
  subscription: Stripe.Subscription,
): Promise<string | null> => {
  const fromMetadata = subscription.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readSubscriptionPriceId(subscription);
  if (!priceId) return null;

  const plan = await db.getPlanByStripePriceId(priceId);
  return plan?.plan_code ?? null;
};

const resolvePlanCodeFromInvoice = async (
  invoice: Stripe.Invoice,
  subscription: SubscriptionInfoByStripe | null,
): Promise<string | null> => {
  const fromMetadata = invoice.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readInvoicePriceId(invoice);
  if (priceId) {
    const byPrice = await db.getPlanByStripePriceId(priceId);
    if (byPrice?.plan_code) return byPrice.plan_code;
  }

  return subscription?.plan_id ?? null;
};

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const telegram_user_id = session.metadata?.telegram_user_id?.trim();
  const payment_token = session.metadata?.payment_token;
  const plan = session.metadata?.plan;

  if (!telegram_user_id) {
    throw new Error(
      "checkout.session.completed missing metadata.telegram_user_id",
    );
  }

  await db.ensureUserForTelegram(
    telegram_user_id,
    session.metadata?.telegram_username,
  );

  if (payment_token) {
    await db.markPaymentSessionUsed(payment_token);
  }
}

async function resolveTelegramUserIdForSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const fromMetadata = subscription.metadata?.telegram_user_id?.trim();
  if (fromMetadata) return fromMetadata;

  const bySubId = await db.getSubscriptionInfoByStripeSubscriptionId(
    subscription.id,
  );
  if (bySubId?.telegram_user_id) return bySubId.telegram_user_id;

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) return null;

  const byCustomer = await db.getSubscriptionInfoByStripeCustomerId(customerId);
  if (byCustomer?.telegram_user_id) return byCustomer.telegram_user_id;

  return null;
}

export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription,
): Promise<void> {
  const telegram_user_id =
    await resolveTelegramUserIdForSubscription(subscription);
  if (!telegram_user_id) {
    console.warn(
      "Unable to resolve telegram_user_id for subscription event",
      subscription.id,
    );
    return;
  }

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} missing customer id`);
  }

  const periodStart = parseUnixSecondsToDate(subscription.current_period_start);
  const periodEnd = parseUnixSecondsToDate(subscription.current_period_end);
  const endedAt = parseUnixSecondsToDate(subscription.ended_at);

  // Use Stripe status directly (all 8 statuses)
  const status = subscription.status;
  const stripeStatus = subscription.status;
  const planCode = await resolvePlanCodeFromSubscription(subscription);
  const currentPeriodBeforeUpsert =
    await db.getCurrentPeriodByTelegramId(telegram_user_id);

  let effectivePlanCode = planCode;
  if (
    periodStart &&
    periodEnd &&
    planCode &&
    currentPeriodBeforeUpsert?.stripe_subscription_id === subscription.id &&
    currentPeriodBeforeUpsert.plan_id &&
    currentPeriodBeforeUpsert.plan_id !== planCode
  ) {
    const currentStartMs = new Date(
      currentPeriodBeforeUpsert.current_period_start,
    ).getTime();
    const currentEndMs = new Date(
      currentPeriodBeforeUpsert.current_period_end,
    ).getTime();
    const incomingStartMs = periodStart.getTime();
    const incomingEndMs = periodEnd.getTime();
    const isSameBillingWindow =
      Number.isFinite(currentStartMs) &&
      Number.isFinite(currentEndMs) &&
      currentStartMs === incomingStartMs &&
      currentEndMs === incomingEndMs;

    if (isSameBillingWindow) {
      const [currentPlan, incomingPlan] = await Promise.all([
        db.getPlanByCode(currentPeriodBeforeUpsert.plan_id),
        db.getPlanByCode(planCode),
      ]);
      const currentAmount = currentPlan?.price_cents_monthly ?? null;
      const incomingAmount = incomingPlan?.price_cents_monthly ?? null;

      // Downgrade during the same billing window should not reduce current-cycle entitlement.
      // Keep current period's plan; next invoice.paid will create the next cycle with new plan.
      if (
        typeof currentAmount === "number" &&
        typeof incomingAmount === "number" &&
        incomingAmount < currentAmount
      ) {
        effectivePlanCode = currentPeriodBeforeUpsert.plan_id;
        console.log(
          "[payment] preserve current cycle plan on downgrade (same billing window)",
          {
            subscriptionId: subscription.id,
            telegramUserId: telegram_user_id,
            currentPlan: currentPeriodBeforeUpsert.plan_id,
            incomingPlan: planCode,
          },
        );
      }
    }
  }

  const payload: {
    telegram_user_id: string;
    stripe_customer_id: string;
    stripe_subscription_id: string;
    telegram_username?: string;
    plan_id?: string;
  } = {
    telegram_user_id,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
  };
  const username = subscription.metadata?.telegram_username;
  if (typeof username === "string" && username.trim())
    payload.telegram_username = username.trim();
  if (effectivePlanCode) payload.plan_id = effectivePlanCode;

  // 事件只维护周期表；「当前生效」由时间决定。若当前生效的是更新订阅，则跳过旧订阅的周期写入。
  const inactiveStatuses: Stripe.Subscription.Status[] = [
    "canceled",
    "incomplete_expired",
    "unpaid",
  ];
  if (inactiveStatuses.includes(status)) {
    const currentPeriod = currentPeriodBeforeUpsert;
    if (
      currentPeriod?.stripe_subscription_id &&
      currentPeriod.stripe_subscription_id !== subscription.id
    ) {
      console.log(
        "Skipping period upsert for old/canceled subscription (newer subscription is current)",
        {
          oldSubscriptionId: subscription.id,
          currentSubscriptionId: currentPeriod.stripe_subscription_id,
          telegramUserId: telegram_user_id,
        },
      );
      return;
    }
  }

  // 提取 assistant_id（从 subscription.metadata）
  let assistantId: number | undefined = undefined;
  if (subscription.metadata?.assistant_id) {
    const parsed = Number.parseInt(
      String(subscription.metadata.assistant_id),
      10,
    );
    if (Number.isFinite(parsed)) assistantId = parsed;
  }

  // 如果有完整的 period 信息，upsert 整个周期
  if (periodStart && periodEnd && effectivePlanCode) {
    try {
      await db.upsertSubscriptionPeriod({
        telegram_user_id,
        telegram_username: payload.telegram_username ?? null,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: customerId,
        period_start: periodStart,
        period_end: periodEnd,
        plan_id: effectivePlanCode,
        status,
        cancel_at_period_end:
          typeof subscription.cancel_at_period_end === "boolean"
            ? subscription.cancel_at_period_end
            : false,
        assistant_id: assistantId ?? null,
      });
    } catch (err) {
      console.warn("[payment] subscription_periods upsert failed (non-fatal)", {
        subscriptionId: subscription.id,
        telegramUserId: telegram_user_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (typeof subscription.cancel_at_period_end === "boolean") {
    // 即使 period 为空，也更新 cancel_at_period_end 和 status（用于取消订阅）
    try {
      await db.updateSubscriptionCancelFlag(
        subscription.id,
        subscription.cancel_at_period_end,
        status,
      );
    } catch (err) {
      console.warn("[payment] update cancel_at_period_end failed (non-fatal)", {
        subscriptionId: subscription.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Immediate cancellation: Stripe marks subscription as canceled now.
  // Keep period table aligned by cutting any future period_end back to ended_at.
  if (
    status === "canceled" &&
    subscription.cancel_at_period_end === false &&
    endedAt
  ) {
    try {
      await db.truncateSubscriptionPeriodsAt(subscription.id, endedAt, status);
    } catch (err) {
      console.warn(
        "[payment] truncate subscription period_end on immediate cancellation failed (non-fatal)",
        {
          subscriptionId: subscription.id,
          telegramUserId: telegram_user_id,
          endedAt: endedAt.toISOString(),
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  const telegramUsername = payload.telegram_username ?? null;

  // 「是否应提供服务」由当前时间落在的周期决定，与定时任务一致
  const currentPeriod = await db.getCurrentPeriodByTelegramId(telegram_user_id);
  const activeStatuses: Stripe.Subscription.Status[] = [
    "active",
    "trialing",
    "past_due",
  ];
  const hasActiveStatus =
    currentPeriod !== null &&
    activeStatuses.includes(
      currentPeriod.status as (typeof activeStatuses)[number],
    );
  const isWithinPeriod =
    currentPeriod?.cancel_at_period_end && currentPeriod.current_period_end
      ? new Date(currentPeriod.current_period_end) > new Date()
      : true;

  const shouldProvideService =
    hasActiveStatus &&
    isWithinPeriod &&
    (currentPeriod?.plan_id ?? effectivePlanCode);

  // Do NOT trigger container creation/restart when the subscription event is
  // a cancel_at_period_end update. The user still has service until period end,
  // but we should not restart a crashed container as a side effect of cancellation.
  // Container restarts should only happen on new subscriptions (invoice.paid).
  const isCancellationEvent =
    typeof subscription.cancel_at_period_end === "boolean" &&
    subscription.cancel_at_period_end === true;

  if (shouldProvideService && !isCancellationEvent) {
    // Sync budget before starting containers — Stripe events can arrive out of order,
    // so subscription.updated (active) may arrive before invoice.paid. Without this,
    // the user would get Budget=0 and hit ExceededBudget on first message.
    if (effectivePlanCode) {
      try {
        await syncLiteLLMBudgetFromPlan({
          telegram_user_id,
          telegram_username: telegramUsername,
          plan_code: effectivePlanCode,
          source: "subscription_sync_before_container",
        });
      } catch (err) {
        console.warn(
          "Budget sync before container start failed (invoice.paid will retry)",
          {
            telegramUserId: telegram_user_id,
            planCode: effectivePlanCode,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    // Ensure runtime for assistants asynchronously (create assistant first if absent).
    try {
      const user = await getUserByTelegramId(Number(telegram_user_id));
      if (user) {
        let assistants = await listAssistantsByOwnerTelegramId(
          Number(telegram_user_id),
        );

        if (assistants.length === 0) {
          try {
            await createAssistantWithoutContainer({
              ownerTelegramUserId: Number(telegram_user_id),
              ownerTelegramUsername: telegramUsername,
            });
          } catch (error: unknown) {
            if (!isAssistantAlreadyExistsError(error)) {
              throw error;
            }
          }
          assistants = await listAssistantsByOwnerTelegramId(
            Number(telegram_user_id),
          );
        }

        const candidates = assistantId
          ? assistants.filter((assistant) => assistant.id === assistantId)
          : assistants;
        const toStart = candidates.filter((assistant) =>
          shouldEnsureAssistantRuntime(assistant.container_status),
        );

        if (toStart.length > 0) {
          const listStr = toStart
            .map((a) => {
              const u = a.assistant_bot_username ?? `#${a.id}`;
              return u.startsWith("#") ? u : `@${u}`;
            })
            .join(", ");
          await sendTelegramMessage(
            Number(telegram_user_id),
            `⏳ <b>Creating container(s)</b>\n\n${listStr}\n\nStarting up, please wait. First launch may take a few minutes — we'll notify you when ready.`,
          );

          // Fire-and-forget: create containers in background
          const chatId = Number(telegram_user_id);
          void (async () => {
            try {
              const results: { label: string; ok: boolean }[] = [];
              for (const assistant of toStart) {
                const label =
                  assistant.assistant_bot_username ?? `#${assistant.id}`;
                const displayLabel = label.startsWith("#")
                  ? label
                  : `@${label}`;
                try {
                  const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(
                    Number(telegram_user_id),
                    assistant,
                  );
                  await ensureAssistantContainer(
                    assistantWithLiteLLM,
                    user.gateway_token,
                  );
                  results.push({ label: displayLabel, ok: true });
                  console.log(
                    `Started container for assistant ${assistant.id} after subscription sync`,
                  );
                } catch (error: unknown) {
                  results.push({ label: displayLabel, ok: false });
                  console.error(
                    `Failed to start container for assistant ${assistant.id}`,
                    {
                      assistantId: assistant.id,
                      error:
                        error instanceof Error ? error.message : String(error),
                    },
                  );
                }
              }
              const succeeded = results.filter((r) => r.ok).map((r) => r.label);
              const failed = results.filter((r) => !r.ok).map((r) => r.label);
              const parts: string[] = [];
              if (succeeded.length > 0) {
                parts.push(
                  `✅ <b>Container(s) ready</b>\n\n${succeeded.join(", ")}\n\nYour assistant is warming up and will be fully ready in about a minute. You can start chatting now!`,
                );
              }
              if (failed.length > 0) {
                parts.push(
                  `❌ <b>Creation failed</b>\n\n${failed.join(", ")}\n\nPlease contact support.`,
                );
              }
              if (parts.length > 0) {
                const msg = parts.join("\n\n");
                console.log("Sending container ready/failed notification", {
                  chatId,
                  succeededCount: succeeded.length,
                  failedCount: failed.length,
                });
                const sendResult = await sendTelegramMessage(chatId, msg);
                if (!sendResult.ok) {
                  console.error("Failed to send container notification", {
                    chatId,
                    error: sendResult.error,
                  });
                }
              }
            } catch (err: unknown) {
              console.error("Async container creation notification error", {
                chatId,
                error: err instanceof Error ? err.message : String(err),
              });
              try {
                await sendTelegramMessage(
                  chatId,
                  "❌ Container creation completed but we couldn't send the status. Please check the guide bot for your Gateway link.",
                );
              } catch {
                /* ignore */
              }
            }
          })();
        }
      }
    } catch (error: unknown) {
      console.error("Failed to start containers after subscription sync", {
        telegramUserId: telegram_user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // 仅当「当前时间落在的周期」就是本订阅时，才清零 budget（与定时任务一致）
  const currentPeriodForInactive =
    await db.getCurrentPeriodByTelegramId(telegram_user_id);
  const isCurrentSubscription =
    currentPeriodForInactive?.stripe_subscription_id === subscription.id;

  if (isCurrentSubscription) {
    await syncLiteLLMBudgetAbsolute({
      telegram_user_id,
      telegram_username: telegramUsername,
      budget_usd: 0,
      source: "stripe_subscription_sync",
      metadata: {
        subscription_status: status,
        plan_code: effectivePlanCode,
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
    });

    try {
      const assistants = await listAssistantsByOwnerTelegramId(
        Number(telegram_user_id),
      );
      for (const assistant of assistants) {
        if (assistant.container_status === "running") {
          await stopAssistantContainer({
            id: assistant.id,
            assistant_bot_id: assistant.assistant_bot_id,
            container_id: assistant.container_id,
            container_name: assistant.container_name,
          });
          console.log(
            `Stopped container for assistant ${assistant.id} due to inactive subscription`,
          );
        }
      }
    } catch (error: unknown) {
      console.error("Failed to stop containers for inactive subscription", {
        telegramUserId: telegram_user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    console.log(
      "Skipping budget zeroing for non-current subscription (or no current period yet)",
      {
        targetSubscriptionId: subscription.id,
        currentSubscriptionId:
          currentPeriodForInactive?.stripe_subscription_id ?? null,
        telegramUserId: telegram_user_id,
      },
    );
  }
}

const resolveSubscriptionFromInvoice = async (
  invoice: Stripe.Invoice,
): Promise<SubscriptionInfoByStripe | null> => {
  // 按 Stripe API 优先级解析 subscription_id
  let subscriptionId: string | undefined;

  // 类型断言：Stripe TypeScript 定义可能不包含 parent 字段，但 API 实际返回
  const invoiceWithParent = invoice as any;

  // 1. invoice.parent.subscription_details.subscription (Stripe 新版 API)
  const parentSub =
    invoiceWithParent.parent?.subscription_details?.subscription;
  if (typeof parentSub === "string" && parentSub.trim()) {
    subscriptionId = parentSub;
  }

  // 2. invoice.subscription (旧版或直接展开的情况)
  if (!subscriptionId) {
    subscriptionId =
      typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription?.id;
  }

  // 3. invoice.lines[0].parent.subscription_item_details.subscription (备选)
  if (!subscriptionId) {
    const lineParent = (invoice.lines?.data?.[0] as any)?.parent
      ?.subscription_item_details?.subscription;
    if (typeof lineParent === "string" && lineParent.trim()) {
      subscriptionId = lineParent;
    }
  }

  // 优先从 Stripe Subscription 的 metadata 解析（第一次付款时表里还没数据）
  if (subscriptionId) {
    try {
      const stripeSub =
        await requireStripe().subscriptions.retrieve(subscriptionId);
      const telegramUserIdFromSub =
        stripeSub.metadata?.telegram_user_id?.trim();
      if (telegramUserIdFromSub) {
        return {
          telegram_user_id: telegramUserIdFromSub,
          telegram_username:
            stripeSub.metadata?.telegram_username?.trim() ?? null,
          stripe_subscription_id: subscriptionId,
          plan_id: stripeSub.metadata?.plan?.trim() ?? null,
        };
      }
    } catch (err) {
      console.warn("Failed to retrieve subscription from Stripe", {
        subscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 其次从 subscription_periods 表解析（已有订阅的场景）
  if (subscriptionId) {
    const bySub =
      await db.getSubscriptionInfoByStripeSubscriptionId(subscriptionId);
    if (bySub) return bySub;
  }

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (customerId) {
    const byCustomer =
      await db.getSubscriptionInfoByStripeCustomerId(customerId);
    if (byCustomer) return byCustomer;
  }

  // 按优先级解析 metadata
  let telegramUserId: string | undefined;
  let telegramUsername: string | null = null;
  let planId: string | null = null;

  // 1. invoice.parent.subscription_details.metadata (最准确)
  const parentMetadata =
    invoiceWithParent.parent?.subscription_details?.metadata;
  if (parentMetadata?.telegram_user_id) {
    telegramUserId = parentMetadata.telegram_user_id?.trim();
    telegramUsername = parentMetadata.telegram_username?.trim() ?? null;
    planId = parentMetadata.plan?.trim() ?? null;
  }

  // 2. invoice.lines[0].metadata (次选)
  if (!telegramUserId) {
    const firstLine = invoice.lines?.data?.[0];
    if (firstLine?.metadata) {
      telegramUserId = (firstLine.metadata as any).telegram_user_id?.trim();
      telegramUsername =
        (firstLine.metadata as any).telegram_username?.trim() ??
        telegramUsername;
      planId = (firstLine.metadata as any).plan?.trim() ?? planId;
    }
  }

  // 3. invoice.metadata (可能为空)
  if (!telegramUserId) {
    telegramUserId = invoice.metadata?.telegram_user_id?.trim();
    telegramUsername =
      invoice.metadata?.telegram_username?.trim() ?? telegramUsername;
    planId = invoice.metadata?.plan?.trim() ?? planId;
  }

  if (telegramUserId) {
    const current = await db.getCurrentPeriodByTelegramId(telegramUserId);
    if (current)
      return {
        telegram_user_id: current.telegram_user_id,
        telegram_username: current.telegram_username,
        stripe_subscription_id: current.stripe_subscription_id,
        plan_id: current.plan_id,
      };
    return {
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      stripe_subscription_id: subscriptionId ?? "",
      plan_id: planId,
    };
  }

  return null;
};

export async function handleInvoicePaid(
  eventId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const subscription = await resolveSubscriptionFromInvoice(invoice);
  if (
    !subscription?.telegram_user_id ||
    !subscription?.stripe_subscription_id
  ) {
    console.warn(
      "invoice.paid could not resolve subscription user",
      invoice.id || eventId,
    );
    return;
  }

  const planCode = await resolvePlanCodeFromInvoice(invoice, subscription);
  if (!planCode) {
    console.warn("invoice.paid missing plan code", {
      invoiceId: invoice.id,
      subscriptionId: subscription.stripe_subscription_id,
      telegramUserId: subscription.telegram_user_id,
    });
    return;
  }

  const stripeSubscriptionId = subscription.stripe_subscription_id;

  // 优先从 invoice.lines[0].period 获取周期（首次付款时 subscription 可能还是 incomplete 状态）
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;

  const firstLine = invoice.lines?.data?.[0];
  if (firstLine?.period?.start && firstLine?.period?.end) {
    periodStart = parseUnixSecondsToDate(firstLine.period.start);
    periodEnd = parseUnixSecondsToDate(firstLine.period.end);
  }

  // 回退到从 Stripe Subscription 获取
  if (!periodStart || !periodEnd) {
    const stripeSub =
      await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
    periodStart = parseUnixSecondsToDate(stripeSub.current_period_start);
    periodEnd = parseUnixSecondsToDate(stripeSub.current_period_end);
  }

  if (!periodStart || !periodEnd) {
    console.warn("invoice.paid could not resolve period", {
      invoiceId: invoice.id,
      stripeSubscriptionId,
    });
    return;
  }

  // 提取 assistant_id（优先从 lines[0].metadata，其次从 invoice.metadata）
  let assistantId: number | undefined = undefined;
  const firstLineMeta = firstLine?.metadata as any;
  if (firstLineMeta?.assistant_id) {
    const parsed = Number.parseInt(String(firstLineMeta.assistant_id), 10);
    if (Number.isFinite(parsed)) assistantId = parsed;
  }
  if (!assistantId && invoice.metadata?.assistant_id) {
    const parsed = Number.parseInt(String(invoice.metadata.assistant_id), 10);
    if (Number.isFinite(parsed)) assistantId = parsed;
  }
  if (!assistantId && stripeSubscriptionId) {
    try {
      const stripeSub =
        await requireStripe().subscriptions.retrieve(stripeSubscriptionId);
      if (stripeSub.metadata?.assistant_id) {
        const parsed = Number.parseInt(
          String(stripeSub.metadata.assistant_id),
          10,
        );
        if (Number.isFinite(parsed)) assistantId = parsed;
      }
    } catch (err) {
      console.warn("[payment] invoice.paid load subscription metadata failed", {
        invoiceId: invoice.id,
        stripeSubscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("[payment] invoice.paid: upserting subscription_periods", {
    invoiceId: invoice.id,
    telegramUserId: subscription.telegram_user_id,
    assistantId,
    planCode,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });

  // For immediate plan switches on the same Stripe subscription, Stripe may emit
  // a new period that starts "now" while an older local period is still open.
  // Close any overlapping old period first so only one period is active at a time.
  try {
    await db.truncateSubscriptionPeriodsAt(stripeSubscriptionId, periodStart);
  } catch (err) {
    console.warn("[payment] invoice.paid period truncate failed (non-fatal)", {
      invoiceId: invoice.id,
      stripeSubscriptionId,
      periodStart: periodStart.toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await db.upsertSubscriptionPeriod({
    telegram_user_id: subscription.telegram_user_id,
    telegram_username: subscription.telegram_username ?? null,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_invoice_id: invoice.id,
    period_start: periodStart,
    period_end: periodEnd,
    plan_id: planCode,
    status: "active",
    assistant_id: assistantId ?? null,
  });

  // invoice.paid 后也启动容器（不依赖 subscription.updated，因为 period 可能为空）
  try {
    await syncLiteLLMBudgetFromPlan({
      telegram_user_id: subscription.telegram_user_id,
      telegram_username: subscription.telegram_username ?? null,
      plan_code: planCode,
      source: "invoice_paid_provision",
    });
  } catch (err) {
    console.warn("[payment] invoice.paid budget sync failed", {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 启动容器（仅启动与本次支付关联的助理）
  const user = await getUserByTelegramId(Number(subscription.telegram_user_id));
  if (user) {
    let assistants = await listAssistantsByOwnerTelegramId(
      Number(subscription.telegram_user_id),
    );

    if (assistants.length === 0) {
      try {
        await createAssistantWithoutContainer({
          ownerTelegramUserId: Number(subscription.telegram_user_id),
          ownerTelegramUsername: subscription.telegram_username ?? null,
        });
      } catch (error: unknown) {
        if (!isAssistantAlreadyExistsError(error)) {
          throw error;
        }
      }
      assistants = await listAssistantsByOwnerTelegramId(
        Number(subscription.telegram_user_id),
      );
    }

    console.log(`[payment] invoice.paid container provisioning check:`, {
      invoiceId: invoice.id,
      telegramUserId: subscription.telegram_user_id,
      assistantId: assistantId || "NULL",
      totalAssistants: assistants.length,
      assistantStatuses: assistants.map((a) => ({
        id: a.id,
        status: a.container_status,
      })),
    });

    const candidates = assistantId
      ? assistants.filter((assistant) => assistant.id === assistantId)
      : assistants;
    const toStart = candidates.filter((assistant) =>
      shouldEnsureAssistantRuntime(assistant.container_status),
    );

    console.log(`[payment] Containers to start: ${toStart.length}`, {
      toStartIds: toStart.map((a) => a.id),
      filterMode: assistantId ? "by_assistant_id" : "all_non_running",
    });

    if (toStart.length > 0) {
      const chatId = Number(subscription.telegram_user_id);
      const listStr = toStart
        .map((a) => {
          const u = a.assistant_bot_username ?? `#${a.id}`;
          return u.startsWith("#") ? u : `@${u}`;
        })
        .join(", ");

      await sendTelegramMessage(
        chatId,
        `⏳ <b>Creating container(s)</b>\n\n${listStr}\n\nStarting up, please wait. First launch may take a few minutes — we'll notify you when ready.`,
      );

      // 异步启动容器
      void (async () => {
        try {
          const results: { label: string; ok: boolean }[] = [];
          for (const assistant of toStart) {
            const label =
              assistant.assistant_bot_username ?? `#${assistant.id}`;
            const displayLabel = label.startsWith("#") ? label : `@${label}`;
            try {
              const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(
                Number(subscription.telegram_user_id),
                assistant,
              );
              const result = await ensureAssistantContainer(
                assistantWithLiteLLM,
                user.gateway_token,
              );
              // ready=false 表示容器启动了但未就绪（探测中），算部分成功
              results.push({ label: displayLabel, ok: result.ready });
              if (result.ready) {
                console.log(
                  `[payment] Container ready for assistant ${assistant.id} after invoice.paid`,
                );
              } else {
                console.log(
                  `[payment] Container starting for assistant ${assistant.id}, probing in background`,
                );
              }
            } catch (error: unknown) {
              results.push({ label: displayLabel, ok: false });
              console.error(
                `[payment] Failed to start container for assistant ${assistant.id}`,
                {
                  assistantId: assistant.id,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }

          const succeeded = results.filter((r) => r.ok).map((r) => r.label);
          const failed = results.filter((r) => !r.ok).map((r) => r.label);
          const parts: string[] = [];

          if (succeeded.length > 0) {
            parts.push(
              `✅ <b>Container(s) ready</b>\n\n${succeeded.join(", ")}\n\nYour assistant is warming up and will be fully ready in about a minute. You can start chatting now!`,
            );
          }
          if (failed.length > 0) {
            parts.push(
              `⏳ <b>Container(s) starting</b>\n\n${failed.join(", ")}\n\nStill warming up — first launch may take a few minutes. We'll notify you when ready.`,
            );
          }

          if (parts.length > 0) {
            await sendTelegramMessage(chatId, parts.join("\n\n"));
          }
        } catch (err) {
          console.error("[payment] invoice.paid container startup failed", err);
        }
      })();
    }
  }
}

/**
 * 定时任务：对「当前时间已进入且尚未应用 budget」的周期执行 LiteLLM reset spend + set budget，并标记已应用；
 * 对「曾有周期但当前无生效周期」（如已取消且周期已结束）的用户清零 budget 并停容器。
 */
export async function applySubscriptionPeriodBudgets(now?: Date): Promise<{
  processed: number;
  failed: number;
  errors: Array<{ periodId: number; error: string }>;
  endedZeroed: number;
  endedFailed: number;
}> {
  const at = now ?? new Date();
  const periods = await db.getPeriodsToApplyBudget(at);
  let processed = 0;
  let failed = 0;
  const errors: Array<{ periodId: number; error: string }> = [];

  for (const period of periods) {
    try {
      await syncLiteLLMBudgetFromPlan({
        telegram_user_id: period.telegram_user_id,
        telegram_username: period.telegram_username ?? null,
        plan_code: period.plan_id,
        source: "cron_apply_subscription_period",
        reset_spend: true,
      });
      const updated = await db.markPeriodBudgetApplied(period.id);
      if (updated) processed += 1;
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ periodId: period.id, error: msg });
      console.error("[payment] applySubscriptionPeriodBudgets: period failed", {
        periodId: period.id,
        telegramUserId: period.telegram_user_id,
        planId: period.plan_id,
        error: msg,
      });
    }
  }

  const endedUsers = await db.getUsersWithEndedSubscriptionNoCurrentPeriod(at);
  let endedZeroed = 0;
  let endedFailed = 0;

  for (const user of endedUsers) {
    try {
      await syncLiteLLMBudgetAbsolute({
        telegram_user_id: user.telegram_user_id,
        telegram_username: user.telegram_username ?? null,
        budget_usd: 0,
        source: "cron_ended_subscription",
        reset_spend: true,
      });
      endedZeroed += 1;
    } catch (err) {
      endedFailed += 1;
      console.error(
        "[payment] applySubscriptionPeriodBudgets: zero budget for ended subscription failed",
        {
          telegramUserId: user.telegram_user_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    try {
      const assistants = await listAssistantsByOwnerTelegramId(
        Number(user.telegram_user_id),
      );
      for (const assistant of assistants) {
        if (assistant.container_status === "running") {
          await stopAssistantContainer({
            id: assistant.id,
            assistant_bot_id: assistant.assistant_bot_id,
            container_id: assistant.container_id,
            container_name: assistant.container_name,
          });
          console.log(
            `[payment] Stopped container for assistant ${assistant.id} (ended subscription)`,
          );
        }
      }
    } catch (err) {
      console.error(
        "[payment] Failed to stop containers for ended subscription",
        {
          telegramUserId: user.telegram_user_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return {
    processed,
    failed,
    errors,
    endedZeroed,
    endedFailed,
  };
}
