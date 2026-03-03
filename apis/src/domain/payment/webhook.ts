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
    let skipped = false;
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(eventObject as Stripe.Checkout.Session);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = eventObject as Stripe.Subscription;
        const eventCreated = normalizeEventCreated(event.created);
        const eventOrder =
          eventCreated === undefined
            ? "process"
            : await db.claimSubscriptionEventOrder({
                stripe_subscription_id: subscription.id,
                event_created: eventCreated,
                event_id: event.id,
              });
        if (eventOrder === "skip") {
          skipped = true;
          break;
        }
        await syncSubscriptionFromStripe(subscription);
        break;
      }

      case "invoice.paid":
        await handleInvoicePaid(event.id, eventObject as Stripe.Invoice);
        break;
      case "invoice.payment_succeeded":
        // invoice.paid is our single source of truth for provisioning/budget side effects.
        skipped = true;
        break;

      default:
        break;
    }

    await db.markStripeEventProcessed(event.id);
    return { skipped };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown webhook handler error";
    await db.markStripeEventFailed(event.id, message);
    throw error;
  }
};
