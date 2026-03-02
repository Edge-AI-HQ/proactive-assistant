import Stripe from "stripe";
import { db } from "./db.js";
import {
  handleCheckoutCompleted,
  handleInvoicePaid,
  syncSubscriptionFromStripe,
} from "./subscriptionSync.js";
import { requireStripe, requireStripeWebhookSecret } from "./stripeClient.js";
import { buildStripeEventClaimPayload } from "./webhookClaim.js";

export const constructStripeEvent = (
  body: Buffer,
  signature: string,
): Stripe.Event => {
  const stripe = requireStripe();
  const secret = requireStripeWebhookSecret();
  return stripe.webhooks.constructEvent(body, signature, secret);
};

export const claimStripeEventForProcessing = async (
  event: Stripe.Event,
): Promise<{ skipped: boolean }> => {
  const claimPayload = buildStripeEventClaimPayload(event);
  const claim = await db.claimStripeEvent(claimPayload);
  if (claim === "skip") {
    return { skipped: true };
  }
  return { skipped: false };
};

const normalizeEventCreated = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
};

export const processStripeEvent = async (
  event: Stripe.Event,
): Promise<{ skipped: boolean }> => {
  const claimed = await claimStripeEventForProcessing(event);
  if (claimed.skipped) {
    return { skipped: true };
  }

  try {
    const eventObject = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(eventObject as Stripe.Checkout.Session);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const eventCreated = normalizeEventCreated(event.created);
        const eventContext =
          eventCreated === undefined
            ? { event_id: event.id }
            : { event_id: event.id, event_created: eventCreated };
        await syncSubscriptionFromStripe(eventObject as Stripe.Subscription, {
          ...eventContext,
        });
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded":
        await handleInvoicePaid(event.id, eventObject as Stripe.Invoice);
        break;

      default:
        break;
    }

    await db.markStripeEventProcessed(event.id);
    return { skipped: false };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown webhook handler error";
    await db.markStripeEventFailed(event.id, message);
    throw error;
  }
};
