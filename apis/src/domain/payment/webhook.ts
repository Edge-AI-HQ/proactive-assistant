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
        let latestSubscription: Stripe.Subscription = subscription;
        try {
          // Always reconcile against Stripe's latest subscription snapshot.
          // This avoids stale/older webhook payloads overriding newer states.
          latestSubscription = await requireStripe().subscriptions.retrieve(
            subscription.id,
          );
        } catch (error) {
          console.warn(
            "Failed to retrieve latest subscription state, fallback to event payload",
            {
              subscriptionId: subscription.id,
              eventId: event.id,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        await syncSubscriptionFromStripe(latestSubscription);
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
