import { readErrorMessage } from "../transport/errors";
import { pinaiFetch } from "../transport/http";

// ─────────────────────────────────────────────────────────────────────────
// Payment / Subscription — Stripe-backed.
//
// Flow:
//   * listBillingPlans()         — public catalog (basic / pro / max).
//   * getCurrentSubscription()   — authed; returns "Free / Trial / Active /
//                                   Canceled" state for the signed-in user.
//   * createCheckout(planCode)   — authed; returns either a Stripe Checkout
//                                   URL (new sub) or { checkoutUrl: null,
//                                   flow: 'upgrade'|'downgrade' } when the
//                                   existing sub was modified in place.
//   * cancelCurrentSubscription() — soft cancel (cancel_at_period_end=True).
//   * getCustomerPortalUrl()     — Stripe Customer Portal session URL.
// ─────────────────────────────────────────────────────────────────────────

// 'free' is the default state for unsubscribed users — backend
// auto-creates a pai_subscriptions row with plan_code='free' status='active'
// for every user (058 migration). UI only ever sends 'basic'/'pro'/'max'
// to createCheckout — Free isn't a Checkout target.
export type PlanCode = "free" | "basic" | "pro" | "max";

export type SubscriptionStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete";

export interface BillingPlanPublic {
  planCode: PlanCode;
  displayName: string;
  currency: string;
  priceCentsMonthly: number;
  monthlyRefreshCredits: number;
  trialPeriodDays: number;
  sortOrder: number;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  planCode: PlanCode | null;
  /**
   * Plan scheduled to take effect at next renewal. Set when the user
   * switches plan mid-period (upgrade or downgrade); the switch only
   * activates on the next invoice.paid. NULL = no scheduled change.
   */
  pendingPlanCode: PlanCode | null;
  accessGranted: boolean;
  currentPeriodStart?: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export type CheckoutFlow = "new" | "upgrade" | "downgrade" | "revoke";

export interface CreateCheckoutResponse {
  checkoutUrl: string | null;
  sessionId?: string;
  flow: CheckoutFlow;
  /** Set on upgrade/downgrade (scheduled-for-next-cycle switch). */
  pendingPlanCode?: PlanCode | null;
}

export interface CancelSubscriptionResponse {
  ok: boolean;
  currentPeriodEnd: string | null;
  alreadyScheduled?: boolean;
}

export async function listBillingPlans(): Promise<BillingPlanPublic[]> {
  const res = await pinaiFetch("/api/payment/plans");
  if (!res.ok) {
    throw new Error(`/payment/plans failed: ${await readErrorMessage(res)}`);
  }
  const data = (await res.json()) as { items?: BillingPlanPublic[] };
  return data.items ?? [];
}

export async function getCurrentSubscription(): Promise<SubscriptionState> {
  const res = await pinaiFetch("/api/payment/subscription");
  if (!res.ok) {
    throw new Error(
      `/payment/subscription failed: ${await readErrorMessage(res)}`,
    );
  }
  return (await res.json()) as SubscriptionState;
}

export async function createCheckout(
  planCode: PlanCode,
  opts?: { successUrl?: string; cancelUrl?: string },
): Promise<CreateCheckoutResponse> {
  const res = await pinaiFetch("/api/payment/create-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planCode,
      successUrl: opts?.successUrl,
      cancelUrl: opts?.cancelUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `/payment/create-checkout failed: ${await readErrorMessage(res)}`,
    );
  }
  return (await res.json()) as CreateCheckoutResponse;
}

export interface TopupResponse {
  checkoutUrl: string;
  sessionId?: string;
  flow: "topup";
}

/**
 * Buy a one-off credit topup. `amountCents` is integer cents (1 credit =
 * $0.01, bought 1:1). Returns a Stripe Checkout (mode='payment') URL to
 * redirect to; the credits land via the checkout.session.completed webhook,
 * so the balance updates after the user completes payment (poll getUsage).
 */
export async function createTopup(
  amountCents: number,
  opts?: { successUrl?: string; cancelUrl?: string },
): Promise<TopupResponse> {
  const res = await pinaiFetch("/api/payment/topup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amountCents,
      successUrl: opts?.successUrl,
      cancelUrl: opts?.cancelUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(`/payment/topup failed: ${await readErrorMessage(res)}`);
  }
  return (await res.json()) as TopupResponse;
}

export async function cancelCurrentSubscription(): Promise<CancelSubscriptionResponse> {
  const res = await pinaiFetch("/api/payment/cancel", { method: "POST" });
  if (!res.ok) {
    throw new Error(`/payment/cancel failed: ${await readErrorMessage(res)}`);
  }
  return (await res.json()) as CancelSubscriptionResponse;
}

export async function getCustomerPortalUrl(
  opts?: { returnUrl?: string },
): Promise<{ portalUrl: string }> {
  const res = await pinaiFetch("/api/payment/customer-portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnUrl: opts?.returnUrl }),
  });
  if (!res.ok) {
    throw new Error(
      `/payment/customer-portal failed: ${await readErrorMessage(res)}`,
    );
  }
  return (await res.json()) as { portalUrl: string };
}

// ── Reconcile (sync local DB from Stripe — used when webhook isn't forwarded) ──

export interface ReconcileResult {
  synced: boolean;
  reason?: string;
  subscriptionId?: string;
  status?: SubscriptionStatus;
  planCode?: PlanCode | null;
  totalActive?: number;
  // Subs that will keep billing (active and NOT scheduled to cancel).
  // Use this for the "duplicate subscriptions" warning, not totalActive.
  activelyRenewing?: number;
}

// ── Usage (LiteLLM spend / budget for current period) ──

export interface UsageInfo {
  spendUsd: number;
  maxBudgetUsd: number;
  planAllowanceCredits?: number;
  topupCreditsAvailable?: number;
  budgetResetAt: string | null;
  budgetDuration: string | null;
}

export async function getUsage(): Promise<UsageInfo> {
  const res = await pinaiFetch("/api/payment/usage");
  if (!res.ok) {
    throw new Error(`/payment/usage failed: ${await readErrorMessage(res)}`);
  }
  return (await res.json()) as UsageInfo;
}

export async function reconcileSubscription(): Promise<ReconcileResult> {
  const res = await pinaiFetch("/api/payment/reconcile", { method: "POST" });
  if (!res.ok) {
    throw new Error(
      `/payment/reconcile failed: ${await readErrorMessage(res)}`,
    );
  }
  return (await res.json()) as ReconcileResult;
}

// ── Payment methods (real cards from Stripe) ──

export interface PaymentMethodEntry {
  id: string;
  // Stripe PaymentMethod type — "card" / "link" / "us_bank_account" / etc.
  // Frontend picks a different display per type (brand+last4 for card,
  // "Link · email" for link, etc.).
  type: string;
  isDefault: boolean;
  isSaved?: boolean;
  source?: "saved" | "checkout";
  // Card-specific (null when type != "card"):
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  // Link-specific (null when type != "link"):
  linkEmail: string | null;
}

export async function listPaymentMethods(): Promise<PaymentMethodEntry[]> {
  const res = await pinaiFetch("/api/payment/payment-methods");
  if (!res.ok) {
    throw new Error(
      `/payment/payment-methods failed: ${await readErrorMessage(res)}`,
    );
  }
  const data = (await res.json()) as { items?: PaymentMethodEntry[] };
  return data.items ?? [];
}

// ── Invoices (real billing history from Stripe) ──

export interface InvoiceEntry {
  id: string;
  number: string | null;
  status: string;
  amountPaidCents: number;
  amountDueCents: number;
  currency: string;
  description: string;
  createdAt: number;  // unix epoch seconds
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export async function listInvoices(limit = 12): Promise<InvoiceEntry[]> {
  const res = await pinaiFetch(
    `/api/payment/invoices?limit=${encodeURIComponent(String(limit))}`,
  );
  if (!res.ok) {
    throw new Error(
      `/payment/invoices failed: ${await readErrorMessage(res)}`,
    );
  }
  const data = (await res.json()) as { items?: InvoiceEntry[] };
  return data.items ?? [];
}

export interface PaymentHistoryEntry {
  id: string;
  kind: "invoice" | "topup";
  status: string;
  amountPaidCents: number;
  currency: string;
  description: string;
  createdAt: number;  // unix epoch seconds
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export async function listPaymentHistory(limit = 12): Promise<PaymentHistoryEntry[]> {
  const res = await pinaiFetch(
    `/api/payment/history?limit=${encodeURIComponent(String(limit))}`,
  );
  if (!res.ok) {
    throw new Error(
      `/payment/history failed: ${await readErrorMessage(res)}`,
    );
  }
  const data = (await res.json()) as { items?: PaymentHistoryEntry[] };
  return data.items ?? [];
}
