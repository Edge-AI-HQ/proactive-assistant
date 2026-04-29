import Stripe from "stripe";
import { setLogContextIdentity } from "../common/requestLogContext.js";
import { db } from "./db.js";
import {
  handleCheckoutCompleted,
  handleInvoicePaid,
  syncSubscriptionFromStripe,
} from "./subscriptionSync.js";
import { requireStripe, requireStripeWebhookSecret } from "./stripeClient.js";
import { buildStripeEventClaimPayload } from "./webhookClaim.js";

const toUserIdFromString = (value: unknown): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(raw) ? raw : null;
};

const toDisplayName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^@+/, "");
  return normalized || undefined;
};

const bindWebhookIdentity = (event: Stripe.Event): void => {
  const obj = event.data.object as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== "object") return;

  const metadata =
    typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : null;
  const idFromMetadata = toUserIdFromString(metadata?.supabase_user_id);
  const nameFromMetadata = toDisplayName(metadata?.display_name);
  if (idFromMetadata) {
    setLogContextIdentity(idFromMetadata, nameFromMetadata);
    return;
  }

  const maybeCustomer = obj.customer;
  if (typeof maybeCustomer === "object" && maybeCustomer !== null) {
    const customerObj = maybeCustomer as Record<string, unknown>;
    const customerMeta =
      typeof customerObj.metadata === "object" && customerObj.metadata !== null
        ? (customerObj.metadata as Record<string, unknown>)
        : null;
    const fromCustomerMeta = toUserIdFromString(customerMeta?.supabase_user_id);
    const fromCustomerName = toDisplayName(customerMeta?.display_name);
    if (fromCustomerMeta) {
      setLogContextIdentity(fromCustomerMeta, fromCustomerName);
    }
  }
};

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
  bindWebhookIdentity(event);
  console.log("[payment] webhook:received", {
    event_id: event.id,
    event_type: event.type,
  });

  const claimed = await claimStripeEventForProcessing(event);
  if (claimed.skipped) {
    console.log("[payment] webhook:skip_already_claimed", {
      event_id: event.id,
      event_type: event.type,
    });
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
    console.log("[payment] webhook:processed", {
      event_id: event.id,
      event_type: event.type,
      skipped,
    });
    return { skipped };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown webhook handler error";
    await db.markStripeEventFailed(event.id, message);
    console.error("[payment] webhook:failed", {
      event_id: event.id,
      event_type: event.type,
      error: message,
    });
    throw error;
  }
};
