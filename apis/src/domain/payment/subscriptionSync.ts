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
import { sendTelegramMessage } from "../telegram/notify.js";

const parseUnixSecondsToDate = (value: unknown): Date | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
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
  eventContext?: {
    event_id?: string;
    event_created?: number;
  },
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
  if (planCode) payload.plan_id = planCode;

  // 事件只维护周期表；「当前生效」由时间决定。若当前生效的是更新订阅，则跳过旧订阅的周期写入。
  const inactiveStatuses: Stripe.Subscription.Status[] = [
    "canceled",
    "incomplete_expired",
    "unpaid",
  ];
  if (inactiveStatuses.includes(status)) {
    const currentPeriod =
      await db.getCurrentPeriodByTelegramId(telegram_user_id);
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

  // 如果有完整的 period 信息，upsert 整个周期
  if (periodStart && periodEnd && planCode) {
    try {
      await db.upsertSubscriptionPeriod({
        telegram_user_id,
        telegram_username: payload.telegram_username ?? null,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: customerId,
        period_start: periodStart,
        period_end: periodEnd,
        plan_id: planCode,
        status,
        cancel_at_period_end:
          typeof subscription.cancel_at_period_end === "boolean"
            ? subscription.cancel_at_period_end
            : false,
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
    hasActiveStatus && isWithinPeriod && (currentPeriod?.plan_id ?? planCode);

  if (shouldProvideService) {
    // Sync budget before starting containers — Stripe events can arrive out of order,
    // so subscription.updated (active) may arrive before invoice.paid. Without this,
    // the user would get Budget=0 and hit ExceededBudget on first message.
    if (planCode) {
      try {
        await syncLiteLLMBudgetFromPlan({
          telegram_user_id,
          telegram_username: telegramUsername,
          plan_code: planCode,
          source: "subscription_sync_before_container",
        });
      } catch (err) {
        console.warn(
          "Budget sync before container start failed (invoice.paid will retry)",
          {
            telegramUserId: telegram_user_id,
            planCode,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    // Start containers for pending/stopped assistants asynchronously.
    try {
      const user = await getUserByTelegramId(Number(telegram_user_id));
      if (user) {
        const assistants = await listAssistantsByOwnerTelegramId(
          Number(telegram_user_id),
        );
        const toStart = assistants.filter(
          (a) =>
            a.container_status === "pending" ||
            a.container_status === "stopped",
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
            `⏳ <b>Creating container(s)</b>\n\n${listStr}\n\nStarting up, please wait. We'll notify you when ready.`,
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
                  await ensureAssistantContainer(assistant, user.gateway_token);
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
                  `✅ <b>Container(s) ready</b>\n\n${succeeded.join(", ")}\n\nYou can open the Gateway link from the guide bot to start chatting.`,
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
    !currentPeriodForInactive ||
    currentPeriodForInactive.stripe_subscription_id === subscription.id;

  if (isCurrentSubscription) {
    await syncLiteLLMBudgetAbsolute({
      telegram_user_id,
      telegram_username: telegramUsername,
      budget_usd: 0,
      source: "stripe_subscription_sync",
      metadata: {
        subscription_status: status,
        plan_code: planCode,
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
      "Skipping budget zeroing for old subscription (user has newer subscription)",
      {
        oldSubscriptionId: subscription.id,
        currentSubscriptionId: currentPeriodForInactive?.stripe_subscription_id,
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

  console.log("[payment] invoice.paid: upserting subscription_periods", {
    invoiceId: invoice.id,
    telegramUserId: subscription.telegram_user_id,
    planCode,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });

  await db.upsertSubscriptionPeriod({
    telegram_user_id: subscription.telegram_user_id,
    telegram_username: subscription.telegram_username ?? null,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_invoice_id: invoice.id,
    period_start: periodStart,
    period_end: periodEnd,
    plan_id: planCode,
    status: "active",
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

  // 启动容器（stopped/pending 的助理）
  const user = await getUserByTelegramId(Number(subscription.telegram_user_id));
  if (user) {
    const assistants = await listAssistantsByOwnerTelegramId(
      Number(subscription.telegram_user_id),
    );
    const toStart = assistants.filter(
      (a) =>
        a.container_status === "pending" || a.container_status === "stopped",
    );

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
        `⏳ <b>Creating container(s)</b>\n\n${listStr}\n\nStarting up, please wait. We'll notify you when ready.`,
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
              await ensureAssistantContainer(assistant, user.gateway_token);
              results.push({ label: displayLabel, ok: true });
              console.log(
                `[payment] Started container for assistant ${assistant.id} after invoice.paid`,
              );
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
              `✅ <b>Container(s) ready</b>\n\n${succeeded.join(", ")}\n\nYou can open the Gateway link from the guide bot to start chatting.`,
            );
          }
          if (failed.length > 0) {
            parts.push(
              `❌ <b>Creation failed</b>\n\n${failed.join(", ")}\n\nPlease contact support.`,
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
