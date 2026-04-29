/**
 * Stripe subscription sync — currently dormant.
 *
 * The previous implementation provisioned per-user resources (assistant
 * container, LiteLLM budget) on subscription events. It's been stubbed
 * pending the proactive-ai paid-plan rollout. When wired back up, the
 * exported surface stays the same and side effects key off
 * `users.supabase_user_id`.
 */
import type Stripe from "stripe";

export const isCancellationScheduledButServiceStillActive = (input: {
  cancel_at_period_end?: boolean | null;
  currentPeriodEnd?: string | Date | null;
  now?: Date;
}): boolean => {
  if (input.cancel_at_period_end !== true) return false;
  if (!input.currentPeriodEnd) return false;

  const periodEnd =
    input.currentPeriodEnd instanceof Date
      ? input.currentPeriodEnd
      : new Date(input.currentPeriodEnd);
  if (!Number.isFinite(periodEnd.getTime())) return false;

  return periodEnd.getTime() > (input.now ?? new Date()).getTime();
};

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  console.warn("[payment] handleCheckoutCompleted: stubbed (no proactive-ai payment integration yet)", {
    sessionId: session.id,
    customer: session.customer,
  });
}

export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription,
): Promise<void> {
  console.warn("[payment] syncSubscriptionFromStripe: stubbed (no proactive-ai payment integration yet)", {
    subscriptionId: subscription.id,
    status: subscription.status,
  });
}

export async function handleInvoicePaid(
  eventId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  console.warn("[payment] handleInvoicePaid: stubbed (no proactive-ai payment integration yet)", {
    eventId,
    invoiceId: invoice.id,
  });
}

export async function applySubscriptionPeriodBudgetsWithLock(
  _now?: Date,
): Promise<{ processed: number; updated: number; skipped: number }> {
  return { processed: 0, updated: 0, skipped: 0 };
}
