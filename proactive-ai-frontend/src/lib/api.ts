/**
 * API client for the pinai-agents cloud service.
 *
 * Single backend: every call goes to pinai-agents via PIN_API_BASE. The
 * old apis Node service has been retired — container management, gateway
 * tickets, per-user model switching are gone (multi-tenant pinai-agents,
 * deployment-wide model selection on LiteLLM).
 *
 * Auth: Supabase JWT is attached automatically via authHeaders().
 */

import { supabase } from "./supabase";
import { PIN_API_BASE, pinApiRequestHeaders } from "./platform";
import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";

export interface Goal {
  id: string;
  user_id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRecord {
  id: string;
  user_id: string;
  display_name: string;
  locale: string;
  timezone: string;
  summary: string | null;
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileMemory {
  id: string;
  user_id: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

export interface ProfileSignal {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_key: string;
  value: number | null;
  source: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

export type PersonalSignalStatus = "open" | "consumed" | "archived";

export interface PersonalSignal {
  id: string;
  kind: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  source: string;
  device_id: string | null;
  subject: string | null;
  salience: number;
  confidence: number;
  status: PersonalSignalStatus;
  dedupe_key: string | null;
  occurred_at: string;
  available_at: string;
  expires_at: string | null;
  ingested_at: string;
  consumed_at: string | null;
  consumed_by_run_id: string | null;
  source_raw_table: string | null;
  source_raw_ids: string[];
  referenced_by_runs: string[];
}

export interface SignalListFilter {
  /** 'all' bypasses the server-side status filter (timeline view). */
  status?: PersonalSignalStatus | "all";
  kind?: string;
  source?: string;
  deviceId?: string;
  since?: string;
  until?: string;
  minSalience?: number;
  limit?: number;
  offset?: number;
  /**
   * Keyset cursor returned in `next_cursor`. Prefer this over `offset` for
   * timelines — it stays O(limit) regardless of how many pages back you go.
   */
  before?: string;
  pruneExpired?: boolean;
}

export interface SignalListResponse {
  ok: boolean;
  signals: PersonalSignal[];
  /** -1 when paginating by cursor (server skips the COUNT). */
  total: number;
  next_cursor: string | null;
  has_more: boolean;
}

type RawPersonalSignal = Partial<PersonalSignal> & {
  availableAt?: string;
  consumedAt?: string | null;
  consumedByRunId?: string | null;
  dedupeKey?: string | null;
  deviceId?: string | null;
  expiresAt?: string | null;
  ingestedAt?: string;
  occurredAt?: string;
  sourceRawIds?: string[];
  sourceRawTable?: string | null;
};

function normalizePersonalSignal(signal: RawPersonalSignal): PersonalSignal {
  return {
    id: signal.id ?? "",
    kind: signal.kind ?? "",
    title: signal.title ?? "",
    summary: signal.summary ?? "",
    payload: signal.payload ?? {},
    source: signal.source ?? "",
    device_id: signal.device_id ?? signal.deviceId ?? null,
    subject: signal.subject ?? null,
    salience: typeof signal.salience === "number" ? signal.salience : 0,
    confidence: typeof signal.confidence === "number" ? signal.confidence : 0,
    status: signal.status ?? "open",
    dedupe_key: signal.dedupe_key ?? signal.dedupeKey ?? null,
    occurred_at: signal.occurred_at ?? signal.occurredAt ?? "",
    available_at: signal.available_at ?? signal.availableAt ?? signal.occurred_at ?? signal.occurredAt ?? "",
    expires_at: signal.expires_at ?? signal.expiresAt ?? null,
    ingested_at: signal.ingested_at ?? signal.ingestedAt ?? "",
    consumed_at: signal.consumed_at ?? signal.consumedAt ?? null,
    consumed_by_run_id: signal.consumed_by_run_id ?? signal.consumedByRunId ?? null,
    source_raw_table: signal.source_raw_table ?? signal.sourceRawTable ?? null,
    source_raw_ids: signal.source_raw_ids ?? signal.sourceRawIds ?? [],
    referenced_by_runs: signal.referenced_by_runs ?? [],
  };
}

export interface ProfileInterest {
  id: string;
  user_id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidence_count: number;
  status: string;
  last_signal_at: string | null;
}

export interface ProfileSnapshot {
  profile: ProfileRecord | null;
  goals: Goal[];
  memories: ProfileMemory[];
  signals: ProfileSignal[];
  interests: ProfileInterest[];
}

export function profileClientHintHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof navigator !== "undefined") {
    const locale = navigator.languages?.[0] || navigator.language;
    if (locale && locale.trim()) {
      headers["X-Pin-Client-Locale"] = locale.trim();
    }
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone && timezone.trim()) {
      headers["X-Pin-Client-Timezone"] = timezone.trim();
    }
  } catch {
    // Browser/runtime did not expose Intl timezone; server keeps its value.
  }

  return headers;
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function authHeaders(): Promise<Record<string, string>> {
  if (isPinLocalDevAuthEnabled()) return pinLocalDevAuthHeaders();
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status}`;

    try {
      const data = JSON.parse(text) as { error?: unknown };
      // New shape: { error: { code, message } } — Stripe / Google Cloud convention.
      if (data?.error && typeof data.error === "object" && data.error !== null) {
        const obj = data.error as { code?: unknown; message?: unknown };
        if (typeof obj.message === "string" && obj.message.trim()) {
          return `${res.status} ${obj.message}`;
        }
      }
      // Legacy shape: { error: "string" }.
      if (typeof data?.error === "string" && data.error.trim()) {
        return `${res.status} ${data.error}`;
      }
    } catch {
      // Fall back to the raw response text when the body is not JSON.
    }

    return `${res.status} ${text}`;
  } catch {
    return `${res.status}`;
  }
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 *
 * Concurrent callers (e.g. multiple panels firing /api/* on AppShell
 * mount and all hitting 401 simultaneously) share one in-flight refresh
 * via the module-level promise cache. Without this, parallel
 * `refreshSession()` calls race against gotrue's single-use refresh
 * token semantics: the first call consumes the refresh token, the rest
 * get "Invalid Refresh Token" and supabase fires SIGNED_OUT — kicking
 * the user back to LoginPage right after login.
 */
let refreshPromise: Promise<string | null> | null = null;

async function refreshAndGetToken(): Promise<string | null> {
  if (isPinLocalDevAuthEnabled()) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) return null;
      return data.session.access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// ── User devices (multi-device registry) ──

export type UserDevicePlatform =
  | "ios" | "android" | "web"
  | "wearable" | "sensor" | "embedded";

export interface UserDevice {
  device_id: string;
  platform: UserDevicePlatform;
  display_name: string | null;
  app_version: string | null;
  model: string | null;
  registered_at: string;
  last_seen_at: string | null;
  status: "active" | "revoked";
  metadata: Record<string, unknown>;
  aliased_device_ids?: string[];
}

export interface RegisterDeviceInput {
  deviceId: string;
  platform: UserDevicePlatform;
  displayName?: string | null;
  appVersion?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

async function pinaiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...pinApiRequestHeaders({
      ...(await authHeaders()),
      ...((init?.headers as Record<string, string>) ?? {}),
    }),
  };
  const url = `${PIN_API_BASE}${path}`;
  const res = await fetch(url, { ...init, headers });
  if (res.status !== 401) return res;
  const freshToken = await refreshAndGetToken();
  if (!freshToken) return res;
  return fetch(url, {
    ...init,
    headers: { ...headers, Authorization: `Bearer ${freshToken}` },
  });
}

export async function listUserDevices(): Promise<UserDevice[]> {
  const res = await pinaiFetch("/api/devices/list");
  if (!res.ok) throw new Error(`/devices/list failed: ${await readErrorMessage(res)}`);
  // pinai-agents returns { items: [...] } with camelCase fields; normalize
  // back to the snake_case UserDevice shape callers expect.
  const data = (await res.json()) as {
    items?: Array<{
      deviceId: string;
      platform: UserDevicePlatform;
      displayName: string | null;
      appVersion: string | null;
      model: string | null;
      registeredAt: string;
      lastSeenAt: string | null;
      status: "active" | "revoked";
      metadata?: Record<string, unknown>;
      aliasedDeviceIds?: string[];
    }>;
  };
  return (data.items ?? []).map((d) => ({
    device_id: d.deviceId,
    platform: d.platform,
    display_name: d.displayName,
    app_version: d.appVersion,
    model: d.model,
    registered_at: d.registeredAt,
    last_seen_at: d.lastSeenAt,
    status: d.status,
    metadata: d.metadata ?? {},
    aliased_device_ids: d.aliasedDeviceIds ?? [d.deviceId],
  }));
}

export async function registerUserDevice(
  input: RegisterDeviceInput,
): Promise<{ device: UserDevice; deviceToken: string }> {
  const res = await pinaiFetch("/api/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/devices/register failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as {
    deviceId: string;
    deviceToken: string;
    platform: UserDevicePlatform;
    registeredAt: string;
  };
  return {
    device: {
      device_id: data.deviceId,
      platform: data.platform,
      display_name: input.displayName ?? null,
      app_version: input.appVersion ?? null,
      model: input.model ?? null,
      registered_at: data.registeredAt,
      last_seen_at: null,
      status: "active",
      metadata: input.metadata ?? {},
    },
    deviceToken: data.deviceToken,
  };
}

export type PushProvider = "apns" | "fcm" | "web";

/**
 * Upsert the APNs/FCM/web push token for a registered device. Idempotent:
 * the server resets push_failure_count to 0 on every successful call, so
 * re-registering a previously-soft-disabled token revives it in place.
 *
 * Called by usePushNotifications on every native registration event —
 * Apple may rotate the token, so each app launch's PUT keeps us current.
 */
export async function setDevicePushToken(
  deviceId: string,
  pushToken: string,
  pushProvider: PushProvider,
): Promise<void> {
  const res = await pinaiFetch(
    `/api/devices/${encodeURIComponent(deviceId)}/push-token`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushToken, pushProvider }),
    },
  );
  if (!res.ok) {
    throw new Error(`/devices/{id}/push-token failed: ${await readErrorMessage(res)}`);
  }
}

/**
 * Debug: schedule a notification 5s in the future. Lets the developer
 * background the app and verify the banner arrives via APNs (not just
 * via the in-app foreground event surface). Returns the server-confirmed
 * delay so callers can show a countdown.
 */
export async function scheduleTestPush(): Promise<{ scheduledInSeconds: number }> {
  const res = await pinaiFetch("/api/devices/test-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`/devices/test-push failed: ${await readErrorMessage(res)}`);
  }
  const data = (await res.json()) as { scheduledInSeconds?: number };
  return { scheduledInSeconds: data.scheduledInSeconds ?? 5 };
}

export async function revokeUserDevice(deviceId: string): Promise<void> {
  const res = await pinaiFetch("/api/devices/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error(`/devices/revoke failed: ${await readErrorMessage(res)}`);
}

/**
 * Fetch a TTL-bounded signed URL for a device-uploaded media blob.
 * The path is the storage_path stored on personal_signals.payload.
 * Returns null when storage isn't configured (dev without Supabase
 * Storage); UI should render a placeholder.
 */
export async function deviceMediaUrl(storagePath: string): Promise<string | null> {
  const res = await pinaiFetch(`/api/devices/media/${storagePath}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { signedUrl?: string };
  return data.signedUrl ?? null;
}

// ── pinai-agents /api/* endpoints ──
//
// `proxyFetch(path)` → `${PIN_API_BASE}/api${path}`. Name kept for caller
// readability — every UI call goes through one helper. Auth header is
// attached + retried once on 401 with a refreshed Supabase session.
export async function proxyFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...pinApiRequestHeaders({
      ...(await authHeaders()),
      ...((init?.headers as Record<string, string>) ?? {}),
    }),
  };
  const url = `${PIN_API_BASE}/api${path}`;
  const res = await fetch(url, { ...init, headers });

  // Retry once with a refreshed token on 401
  if (res.status === 401) {
    const freshToken = await refreshAndGetToken();
    if (freshToken) {
      const retryHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${freshToken}`,
      };
      return fetch(url, { ...init, headers: retryHeaders });
    }
  }

  return res;
}

export async function proxyPost(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return proxyFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

// ── Health (liveness + local-dev branch label) ──
export interface HealthInfo {
  status: string;
  service: string;
  db?: string;
  /** Local-dev only: git branch of the worktree this backend runs on
   *  (Makefile-injected via docker-compose.override.yml). Lets the DebugPanel
   *  show which worktree a tunneled phone is hitting. Absent in prod. */
  dev_label?: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthInfo> {
  // `/health` is mounted at the web root (not under /api) and needs no auth,
  // so a plain fetch is enough. PIN_API_BASE is "" in browser (same-origin,
  // nginx proxies /health) or the ngrok URL on native.
  const res = await fetch(`${PIN_API_BASE}/health`, { signal });
  if (!res.ok) throw new Error(`/health failed: ${res.status}`);
  return res.json();
}


export interface AmbientCloudSummaryDraft {
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: "certain" | "uncertain";
}

export interface AmbientCloudSummaryResponse {
  ok: true;
  draft: AmbientCloudSummaryDraft;
  modelId: string;
}

export async function summarizeAmbientWithCloud(
  context: unknown,
  signal?: AbortSignal,
): Promise<AmbientCloudSummaryResponse> {
  const res = await proxyPost("/ambient/summary", { context }, signal);
  if (!res.ok) throw new Error(`/ambient/summary failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as Partial<AmbientCloudSummaryResponse>;
  if (!data.ok || !data.draft || typeof data.modelId !== "string") {
    throw new Error("/ambient/summary returned invalid response");
  }
  return data as AmbientCloudSummaryResponse;
}

export async function recordCardOpen(
  cardId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const res = await proxyPost(
    `/reward-dashboard/cards/${encodeURIComponent(cardId)}/score`,
    {
      source: "user",
      eventType: "card_open",
      score: 1,
      metadata,
    },
  );
  if (!res.ok) {
    throw new Error(`/reward-dashboard card_open failed: ${await readErrorMessage(res)}`);
  }
}

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

/**
 * Permanently delete the signed-in user's account and all associated
 * data. Backend chains: Composio disconnect → LiteLLM key revoke →
 * Stripe subscription cancel → Browserbase context delete → Supabase
 * Storage purge → Supabase Auth admin delete (fail-fast) → DB CASCADE
 * across 27 pai_* tables.
 *
 * Once this resolves the caller MUST sign out: the JWT is dead
 * (Supabase Auth user is gone), so any subsequent API call would 401.
 *
 * Throws on fail-fast abort (Supabase Auth couldn't be reached / DB
 * cascade failed). External steps already done are idempotent, so the
 * user can safely retry — the Error carries `.partial` with the
 * per-step result for surfacing in the UI.
 */
type RawDeleteAccountResult = {
  composio_disconnected: number;
  composio_errors: string[];
  litellm_keys_deleted: number;
  litellm_error: string | null;
  stripe_subscription_canceled: boolean;
  stripe_error: string | null;
  browserbase_context_deleted: boolean;
  browserbase_error: string | null;
  storage_files_deleted: number;
  storage_error: string | null;
  supabase_auth_deleted: boolean;
  supabase_auth_error: string | null;
  db_deleted: boolean;
};

export interface DeleteAccountResult {
  composioDisconnected: number;
  composioErrors: string[];
  litellmKeysDeleted: number;
  litellmError: string | null;
  stripeSubscriptionCanceled: boolean;
  stripeError: string | null;
  browserbaseContextDeleted: boolean;
  browserbaseError: string | null;
  storageFilesDeleted: number;
  storageError: string | null;
  supabaseAuthDeleted: boolean;
  supabaseAuthError: string | null;
  dbDeleted: boolean;
}

function normalizeDeleteResult(r: RawDeleteAccountResult): DeleteAccountResult {
  return {
    composioDisconnected: r.composio_disconnected,
    composioErrors: r.composio_errors,
    litellmKeysDeleted: r.litellm_keys_deleted,
    litellmError: r.litellm_error,
    stripeSubscriptionCanceled: r.stripe_subscription_canceled,
    stripeError: r.stripe_error,
    browserbaseContextDeleted: r.browserbase_context_deleted,
    browserbaseError: r.browserbase_error,
    storageFilesDeleted: r.storage_files_deleted,
    storageError: r.storage_error,
    supabaseAuthDeleted: r.supabase_auth_deleted,
    supabaseAuthError: r.supabase_auth_error,
    dbDeleted: r.db_deleted,
  };
}

export class DeleteAccountError extends Error {
  partial: DeleteAccountResult | null;
  constructor(message: string, partial: DeleteAccountResult | null) {
    super(message);
    this.name = "DeleteAccountError";
    this.partial = partial;
  }
}

export async function deleteAccount(): Promise<DeleteAccountResult> {
  const res = await proxyFetch("/account", { method: "DELETE" });
  if (!res.ok) {
    // 502 from the fail-fast path carries { detail: { message, partial_result } }.
    let partial: DeleteAccountResult | null = null;
    let message = `/account DELETE failed: ${res.status}`;
    try {
      const body = (await res.json()) as {
        detail?: { message?: string; partial_result?: RawDeleteAccountResult };
      };
      if (body?.detail?.message) message = `${res.status} ${body.detail.message}`;
      if (body?.detail?.partial_result) {
        partial = normalizeDeleteResult(body.detail.partial_result);
      }
    } catch {
      // Body isn't JSON — fall through with the status-only message.
    }
    throw new DeleteAccountError(message, partial);
  }
  const body = (await res.json()) as { ok: boolean; result: RawDeleteAccountResult };
  return normalizeDeleteResult(body.result);
}

export async function fetchProfileSnapshot(
  signal?: AbortSignal
): Promise<ProfileSnapshot> {
  const res = await proxyFetch("/profile", {
    signal,
    headers: profileClientHintHeaders(),
  });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);

  const data = await res.json();
  return {
    profile: data?.profile ?? null,
    goals: Array.isArray(data?.goals) ? data.goals : [],
    memories: Array.isArray(data?.memories) ? data.memories : [],
    signals: Array.isArray(data?.signals) ? data.signals : [],
    interests: Array.isArray(data?.interests) ? data.interests : [],
  };
}

export async function fetchSignals(
  filter?: SignalListFilter,
  signal?: AbortSignal,
): Promise<SignalListResponse> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.kind) qs.set("kind", filter.kind);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.deviceId) qs.set("deviceId", filter.deviceId);
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (typeof filter?.minSalience === "number") qs.set("minSalience", String(filter.minSalience));
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.before) qs.set("before", filter.before);
  if (filter?.pruneExpired) qs.set("pruneExpired", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/signals${suffix}`, { signal });
  if (!res.ok) throw new Error(`/signals failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as Partial<SignalListResponse>;
  return {
    ok: data.ok ?? false,
    signals: Array.isArray(data.signals)
      ? data.signals.map((signal) => normalizePersonalSignal(signal as RawPersonalSignal))
      : [],
    total: typeof data.total === "number" ? data.total : -1,
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more ?? false,
  };
}

// ── Device unified timeline ───────────────────────────────────────────

export interface DeviceHealthObservation {
  id: string;
  device_id: string;
  observation_type: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  start_at: string | null;
  end_at: string | null;
  local_date: string | null;
  source_app: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
}

export type DeviceTimelineItem =
  | { type: "signal"; occurred_at: string; row: PersonalSignal }
  | { type: "health"; occurred_at: string; row: DeviceHealthObservation };

export interface DeviceTimelineResponse {
  ok: boolean;
  items: DeviceTimelineItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Unified device timeline (signals + raw health observations) ordered
 * by ``occurred_at DESC`` with a single keyset cursor. Backed by
 * `GET /api/devices/{deviceId}/timeline`.
 */
export async function fetchDeviceTimeline(
  deviceId: string,
  opts: { before?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<DeviceTimelineResponse> {
  const qs = new URLSearchParams();
  if (opts.before) qs.set("before", opts.before);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(
    `/devices/${encodeURIComponent(deviceId)}/timeline${suffix}`,
    { signal: opts.signal },
  );
  if (!res.ok) {
    throw new Error(
      `/devices/${deviceId}/timeline failed: ${await readErrorMessage(res)}`,
    );
  }
  const data = (await res.json()) as Partial<DeviceTimelineResponse>;
  return {
    ok: data.ok ?? false,
    items: Array.isArray(data.items) ? data.items : [],
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more ?? false,
  };
}


export interface RawListFilter {
  since?: string;
  until?: string;
  limit?: number;
}

export interface GmailMessage {
  id: string;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  snippet: string | null;
  body: string | null;
  label_ids: string[];
  internal_date: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface GcalEvent {
  id: string;
  calendar_id: string;
  event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  start_at: string | null;
  end_at: string | null;
  attendees: string[];
  status: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceAppRaw {
  id: string;
  snapshot_id: string;
  device_id: string;
  bundle_id: string;
  app_name: string;
  version: string | null;
  last_used_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceContactRaw {
  id: string;
  snapshot_id: string;
  device_id: string;
  display_name: string | null;
  emails: string[];
  phones: string[];
  last_modified: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceHealthRaw {
  id: string;
  device_id: string;
  observation_type: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  start_at: string | null;
  end_at: string | null;
  local_date: string | null;
  source_app: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rawQuery(params?: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      if (value) qs.set(key, "1");
    } else {
      qs.set(key, String(value));
    }
  }
  return qs.toString() ? `?${qs.toString()}` : "";
}

export async function fetchRawGmail(
  filter?: RawListFilter & { threadId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; messages: GmailMessage[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    threadId: filter?.threadId,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/gmail${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/gmail failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawGcal(
  filter?: RawListFilter & { calendarId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; events: GcalEvent[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    calendarId: filter?.calendarId,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/gcal${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/gcal failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceApps(
  filter?: RawListFilter & { deviceId?: string; snapshotId?: string; latestSnapshotOnly?: boolean },
  signal?: AbortSignal,
): Promise<{ ok: boolean; apps: DeviceAppRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    snapshotId: filter?.snapshotId,
    latestSnapshotOnly: filter?.latestSnapshotOnly,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-apps${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-apps failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceContacts(
  filter?: RawListFilter & { deviceId?: string; snapshotId?: string; latestSnapshotOnly?: boolean; search?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; contacts: DeviceContactRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    snapshotId: filter?.snapshotId,
    latestSnapshotOnly: filter?.latestSnapshotOnly,
    search: filter?.search,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-contacts${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-contacts failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceHealth(
  filter?: RawListFilter & { deviceId?: string; observationType?: string; metric?: string; localDate?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; observations: DeviceHealthRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    observationType: filter?.observationType,
    metric: filter?.metric,
    localDate: filter?.localDate,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-health${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-health failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/**
 * Generic raw-table fetcher. Backed by the `/raw/<table>` HTTP dispatcher,
 * which whitelists table names server-side. The shape is identical for
 * every table — `rows` is an array of free-form snake_case records (the
 * raw row as stored in SQLite, including the `id`, `dedupe_key`, and
 * timing columns). UI is expected to dig out display fields from each
 * row generically rather than typing every toolkit individually here.
 */
export interface RawTableRow extends Record<string, unknown> {
  id: string;
  occurred_at?: string;
  ingested_at?: string;
}

export async function fetchRawTable(
  table: string,
  filter?: RawListFilter,
  signal?: AbortSignal,
): Promise<{ ok: boolean; rows: RawTableRow[]; total: number; table: string }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/${encodeURIComponent(table)}${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/${table} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/**
 * SSE stream from the container proxy.
 * Returns an async iterator of parsed JSON events.
 */
export async function* proxySSE<T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const res = await proxyPost(path, body, signal);
  if (!res.ok) throw new Error(`Proxy SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as T;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** GET-based SSE generator — sibling of `proxySSE` (which is POST-only). Used
 * by the resumable conversation stream. Yields `{ event, lastEventId }`: the
 * `lastEventId` is the Redis Stream entry id from the preceding `id:` line (the
 * resume cursor) — the caller stores it and echoes it back as `?lastEventId=`
 * on reconnect so the server replays exactly the frames missed while gone. */
export async function* proxyGetSSE<T = unknown>(
  path: string,
  signal?: AbortSignal
): AsyncGenerator<{ event: T; lastEventId: string | null }> {
  const res = await proxyFetch(path, { signal });
  if (!res.ok) throw new Error(`Proxy GET SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The current resume cursor — tracked across chunks so each event is tagged
  // with the `id:` that preceded it (an id line and its data line can split
  // across reads).
  let lastEventId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // blank / `: ping` keepalive
        if (trimmed.startsWith("id:")) {
          lastEventId = trimmed.slice(3).trim();
          continue;
        }
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield { event: JSON.parse(data) as T, lastEventId };
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Conversation history shapes ──
//    Persisted-turn types for the unified /api/conversation/* history (main /
//    card / proactive). RC-5 removed the standalone /api/proactive/* client;
//    these types now back ConversationHistoryPage.messages.

export interface ConversationHistoryToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  status: "running" | "ok" | "error";
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  args?: unknown;
}

export type ConversationHistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ConversationHistoryToolCallPart;

export interface ConversationHistoryMessage {
  id: string;
  /** `heartbeat` = a heartbeat input (renders as a debug-only heartbeat entry,
   *  not a user bubble). */
  role: "user" | "assistant" | "heartbeat";
  parts: ConversationHistoryPart[];
  createdAt?: number;
  /** Assistant turns only: how the turn was triggered. "tick" → heartbeat-driven
   *  (debug-only); "user" / undefined → user-driven (always shown). */
  trigger?: "tick" | "user";
}

/** Whether the proactive heartbeat is on. Stored in
 * `pai_user_settings.proactive_enabled` and read via the unified settings
 * resource; the server mirrors it into the per-user `proactive.tick` task. */
export async function fetchProactiveEnabled(
  signal?: AbortSignal
): Promise<boolean> {
  const res = await proxyFetch("/settings", { signal });
  if (!res.ok) throw new Error(`/settings failed: ${res.status}`);
  const data = (await res.json()) as { proactiveEnabled?: boolean };
  return !!data.proactiveEnabled;
}

/** Turn the proactive heartbeat on/off via the unified settings resource.
 * Returns the resulting state. */
export async function setProactiveEnabled(enabled: boolean): Promise<boolean> {
  const res = await proxyPost("/settings", { proactiveEnabled: enabled });
  if (!res.ok) throw new Error(`/settings failed: ${res.status}`);
  const data = (await res.json()) as { proactiveEnabled?: boolean };
  return !!data.proactiveEnabled;
}

// ── Conversation agent (unified actor kernel: /api/conversation/*) ──
//    RC-5: one client for main / card / proactive chat, replacing the
//    /api/chat-stream/* (main+card) and /api/proactive/* (proactive) clients.
//    The reply is async — it arrives on conversationStream(), not the send
//    response; HITL pauses surface as chat:requires_action frames resolved by
//    conversationDecision().

export interface ConversationInitResult {
  sessionKey: string;
  kind: "main" | "card" | "proactive";
  existing: boolean;
}

/** Resolve a conversation session_key + whether it already has history. Omit
 *  both hints for the main-chat singleton; pass `cardId` for a card thread's
 *  first open; pass an explicit `sessionKey` to resume a known thread. */
export async function conversationInit(opts?: {
  sessionKey?: string;
  cardId?: string;
  kind?: "main" | "card" | "proactive";
  signal?: AbortSignal;
}): Promise<ConversationInitResult> {
  const body: Record<string, unknown> = {};
  if (opts?.sessionKey) body.session_key = opts.sessionKey;
  if (opts?.cardId) body.card_id = opts.cardId;
  if (opts?.kind) body.kind = opts.kind;
  const res = await proxyPost("/conversation/init", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/init failed: ${res.status}`);
  const data = (await res.json()) as Partial<ConversationInitResult>;
  return {
    sessionKey: data.sessionKey ?? "",
    kind: data.kind ?? "main",
    existing: !!data.existing,
  };
}

/** Enqueue a user message onto the session mailbox (202). The reply arrives
 *  over conversationStream(). `cardContext` rides along for a card / feedback
 *  turn (chat injects it as a <card_context> SystemMessage). */
export async function conversationSend(
  sessionKey: string,
  message: string,
  opts?: {
    cardContext?: Record<string, unknown>;
    /** Re-run the latest user turn: the backend pops the stale assistant
     *  reply from state and regenerates (diffs `message`, not `messages`). */
    regenerate?: boolean;
    signal?: AbortSignal;
  }
): Promise<void> {
  const body: Record<string, unknown> = { session_key: sessionKey, message };
  if (opts?.cardContext) body.cardContext = opts.cardContext;
  if (opts?.regenerate) body.regenerate = true;
  const res = await proxyPost("/conversation/send", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/send failed: ${res.status}`);
}

/** HITL: resolve a paused tool call (a chat:requires_action frame). The
 *  decision rides back through the mailbox + resumes the run via
 *  Command(resume=). `toolUseId` is the frame's `interruptId`. */
export async function conversationDecision(
  sessionKey: string,
  toolUseId: string,
  decision: "approve" | "reject" | "edit" | "respond",
  opts?: { message?: string; signal?: AbortSignal }
): Promise<void> {
  const body: Record<string, unknown> = {
    session_key: sessionKey,
    toolUseId,
    decision,
  };
  if (opts?.message !== undefined) body.message = opts.message;
  const res = await proxyPost("/conversation/decision", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/decision failed: ${res.status}`);
}

/** Stop the session's in-flight turn (idempotent — no-op if nothing runs). */
export async function conversationCancel(
  sessionKey: string,
  signal?: AbortSignal
): Promise<void> {
  const res = await proxyPost(
    "/conversation/cancel",
    { session_key: sessionKey },
    signal
  );
  if (!res.ok) throw new Error(`/conversation/cancel failed: ${res.status}`);
}

/** Long-lived, resumable push stream of a session's frames (SSE envelopes):
 *  thinking / reasoning / tool / text / requires_action / proactive:tick.
 *  Iterate until it ends, then reconnect — passing the last `lastEventId` seen
 *  so the server replays the frames missed during the gap (no loss, no dup).
 *  Yields `{ event, lastEventId }`. */
export function conversationStream<T = unknown>(
  sessionKey: string,
  signal?: AbortSignal,
  lastEventId?: string | null
): AsyncGenerator<{ event: T; lastEventId: string | null }> {
  const params = new URLSearchParams({ session: sessionKey });
  if (lastEventId) params.set("lastEventId", lastEventId);
  return proxyGetSSE<T>(`/conversation/stream?${params.toString()}`, signal);
}

/** Options for {@link conversationHistory}. */
export interface ConversationHistoryOpts {
  signal?: AbortSignal;
  /** Load-older cursor: a row id; returns entries strictly older than it. */
  before?: number;
  /** Page size. Backend caps at 200; default 50. */
  limit?: number;
  /** Include proactive debug-only rows (heartbeat inputs + silent tick turns).
   *  Mirrors the Debug toggle; default false → only user-visible turns (user
   *  messages + tick turns that reached out via notify_user). */
  includeDebug?: boolean;
}

/** A paused HITL run surfaced on the newest history page so the FE can rebuild
 *  the approval gate after a refresh / reconnect (the live /stream never replays
 *  the requires_action frame). Same shape the live frame carries. */
export interface ConversationAwaiting {
  toolUseId: string;
  toolName: string;
  argsPreview?: string;
  allowedDecisions: string[];
  /** Reasoning / tool-call parts the agent streamed before the interrupt (not
   *  yet persisted — they land on resume). Same shape as a history message's
   *  parts; the FE redraws the in-progress turn above the gate on refresh. */
  partialParts: ConversationHistoryPart[];
}

/** One page of a session's persisted turns (pai_chat_messages), oldest-first.
 *  `nextCursor` is the id to pass back as `before` for the next older page
 *  (null when no more). `awaiting` is set only on the newest page (no `before`)
 *  when a HITL run is paused. Reuses the proactive history message shape. */
/** The in-flight turn, surfaced on the newest page so a REFRESH mid-turn can
 *  rebuild it — it isn't in pai_chat_messages until it finishes. `userTexts`
 *  are the user bubble(s) to render (from the unconsumed mailbox; empty for a
 *  regenerate, which reuses the existing bubble). `replayFrom` is the stream
 *  cursor to open /stream from so the agent's frames replay and rebuild the
 *  assistant bubble; null when the turn hasn't produced frames yet (just
 *  sent — the live tail carries them). */
export interface ConversationActive {
  userTexts: string[];
  replayFrom: string | null;
}

export interface ConversationHistoryPage {
  messages: ConversationHistoryMessage[];
  nextCursor: number | null;
  awaiting: ConversationAwaiting | null;
  /** Non-null only on the newest page (no `before`) when a turn is mid-flight. */
  active: ConversationActive | null;
}

export async function conversationHistory(
  sessionKey: string,
  opts: ConversationHistoryOpts = {}
): Promise<ConversationHistoryPage> {
  const params = new URLSearchParams({ session: sessionKey });
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.includeDebug) params.set("include_debug", "true");
  const res = await proxyFetch(`/conversation/history?${params.toString()}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`/conversation/history failed: ${res.status}`);
  const data = (await res.json()) as {
    messages?: ConversationHistoryMessage[];
    nextCursor?: number | null;
    awaiting?: ConversationAwaiting | null;
    active?: ConversationActive | null;
  };
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextCursor: data.nextCursor ?? null,
    awaiting: data.awaiting ?? null,
    active: data.active ?? null,
  };
}

// ── Conversation Crystallize (debug panel) ──

export type TunableCrystallizeKey =
  | "messageThreshold"
  | "cooldownMs"
  | "salienceFloor"
  | "minUserChars";

export type TunableCrystallizeConfig = Partial<Record<TunableCrystallizeKey, number>>;

export type ChatSessionKind = "main" | "card" | "other";

export interface CrystallizeStateResponse {
  ok: boolean;
  state: {
    turn_count: number;
    last_crystallized_at: string | null;
    last_session_key: string | null;
    last_message_at: string | null;
  };
  settings: { auto_crystallize: boolean };
  config: {
    defaults: TunableCrystallizeConfig;
    override: TunableCrystallizeConfig;
    effective: TunableCrystallizeConfig;
    bounds: Record<TunableCrystallizeKey, { min: number; max: number; integer: boolean }>;
  };
  skillCounts: { active: number; disabled: number; total: number };
  recentDecisions: Array<{
    ts: string;
    decision: string;
    salience: number | null;
    summary: string;
    reason: string | null;
    memoryId: string | null;
    skillId: string | null;
    turnCount: number | null;
  }>;
  diagnostics: {
    lastSessionKey: string | null;
    lastSessionKind: ChatSessionKind | null;
    secondsSinceLastBump: number | null;
  };
}

export interface CrystallizeRunResponse {
  ok: boolean;
  result: {
    skipped: boolean;
    reason?: string;
    decision?: string;
    summary?: string;
    salience?: number;
    memoryId?: string;
    skillId?: string;
  };
}

export async function fetchCrystallizeState(signal?: AbortSignal): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/state", { signal });
  if (!res.ok) throw new Error(`/crystallize/state failed: ${res.status}`);
  return res.json();
}

export async function patchCrystallizeConfig(
  patch: Partial<Record<TunableCrystallizeKey, number | null>>,
): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/config failed: ${res.status} ${detail}`);
  }
  return res.json();
}

export async function setAutoCrystallize(enabled: boolean): Promise<void> {
  // Routes through the unified `/api/settings` PATCH-style endpoint.
  // Previously POST'd to `/settings/auto-crystallize` which was never
  // implemented on the backend (silent 404). Field name maps to the
  // `auto_crystallize` column on `pai_user_settings`.
  const res = await proxyPost("/settings", { autoCrystallize: enabled });
  if (!res.ok) throw new Error(`/settings failed: ${res.status}`);
}

export async function forceCrystallizeRun(): Promise<CrystallizeRunResponse> {
  const res = await proxyPost("/crystallize/run", {});
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/run failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// ── v3 Skills (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/skills.ts` which serves v3 `skill_index`
// rows plus the `SKILL.md` body on detail requests. See
// `docs/plans/memory-architecture.mdx` §三.

export type SkillStatus = "enabled" | "disabled" | "archived";

export interface Skill {
  id: string;
  title: string;
  description: string | null;
  status: SkillStatus;
  revision: number;
  body_hash: string;
  triggers: string[];
  source: string;
  created_run_id: string | null;
  last_updated_run_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
  /** Only populated on detail (GET /skills/:id) and after create/update. */
  body?: string;
}

export interface SkillCreateInput {
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  status?: "enabled" | "disabled";
}

export interface SkillPatch {
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  status?: SkillStatus;
}

export async function fetchSkills(
  params?: { status?: SkillStatus; limit?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; skills: Skill[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/skills${suffix}`, { signal });
  if (!res.ok) throw new Error(`/skills failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchSkill(id: string, signal?: AbortSignal): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/skills/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createSkill(input: SkillCreateInput): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyPost("/skills", input);
  if (!res.ok) throw new Error(`create skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateSkill(id: string, patch: SkillPatch): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveSkill(id: string): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`archive skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── v3 Memory (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/memory.ts` (v3 `MemoryRowV3`).
// DELETE is intentionally unavailable: use archive or supersede.

export type MemoryStatus = "active" | "archived" | "superseded";

export interface Memory {
  id: string;
  text: string;
  source: string;
  source_run_id: string | null;
  subject: string | null;
  quality: number;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  occurred_at: string | null;
  created_at: string;
  tags: string[];
  related_memory_ids: string[];
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface MemoryListFilter {
  status?: MemoryStatus;
  source?: string;
  subject?: string;
  subjectPrefix?: string;
  minQuality?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created_at" | "quality" | "last_referenced_at";
  orderDirection?: "asc" | "desc";
}

export interface MemoryCreateInput {
  text: string;
  source: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
  occurredAt?: string | null;
  sourceRunId?: string | null;
}

export interface MemoryPatch {
  text?: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
}

export async function fetchMemories(
  filter?: MemoryListFilter,
  signal?: AbortSignal,
): Promise<{ ok: boolean; memories: Memory[]; total: number }> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.subject) qs.set("subject", filter.subject);
  if (filter?.subjectPrefix) qs.set("subjectPrefix", filter.subjectPrefix);
  if (typeof filter?.minQuality === "number") qs.set("minQuality", String(filter.minQuality));
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.orderBy) qs.set("orderBy", filter.orderBy);
  if (filter?.orderDirection) qs.set("orderDirection", filter.orderDirection);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/memory${suffix}`, { signal });
  if (!res.ok) throw new Error(`/memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchMemory(id: string, signal?: AbortSignal): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/memory/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createMemory(input: MemoryCreateInput): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyPost("/memory", input);
  if (!res.ok) throw new Error(`create memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateMemory(id: string, patch: MemoryPatch): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveMemory(id: string): Promise<void> {
  const res = await proxyPost(`/memory/${encodeURIComponent(id)}/archive`, {});
  if (!res.ok) throw new Error(`archive memory failed: ${await readErrorMessage(res)}`);
}

export async function supersedeMemory(oldId: string, newId: string): Promise<void> {
  const res = await proxyPost("/memory/supersede", { oldId, newId });
  if (!res.ok) throw new Error(`supersede memory failed: ${await readErrorMessage(res)}`);
}

// ── Scheduled generators (user-created recurring card generation) ──
// Backs the Settings > Preferences management list and Main Chat's
// create-via-confirmation flow. Server keys are camelCase (web `_dump`);
// parsedIntent / confirmedBrief are opaque blobs echoed back verbatim on
// create — the backend normalizes their keys, so don't reshape them here.

export interface ScheduledGeneratorParsedIntent {
  frequency?: string;
  localTime?: string;
  timezone?: string;
  topic?: string;
  cardCount?: number;
  [key: string]: unknown;
}

export interface ScheduledGeneratorConfirmedBrief {
  title?: string;
  topic?: string;
  instruction?: string;
  [key: string]: unknown;
}

export interface ScheduledGeneratorTask {
  id: string;
  kind: string;
  status: "active" | "paused" | "archived";
  title: string;
  frequency: string | null;
  localTime: string | null;
  timezone: string;
  cronExpr: string | null;
  /** "once" | "schedule"; optional so tasks from older backends still parse. */
  triggerKind?: string | null;
  intervalSeconds?: number | null;
  scheduleLabel?: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  payload: Record<string, unknown>;
}

export interface ScheduledGeneratorSchedule {
  type: "once" | "interval" | "cron";
  inMinutes?: number;
  atLocal?: string;
  everySeconds?: number;
  frequency?: "daily" | "weekly";
  localTime?: string;
  /** ISO weekday numbers, 1=Monday … 7=Sunday */
  daysOfWeek?: number[];
}

export interface ScheduledGeneratorReminder {
  title: string;
  message: string;
}

export interface ScheduledGeneratorPreview {
  previewId: string;
  parsedIntent: ScheduledGeneratorParsedIntent;
  confirmedBrief: ScheduledGeneratorConfirmedBrief;
  semanticSignature: string;
  similarTasks: ScheduledGeneratorTask[];
  conversationId: string | null;
  scheduleLabel: string;
  mode: string;
  reminder: ScheduledGeneratorReminder | null;
}

export interface ScheduledGeneratorPreviewRequest {
  originalRequest: string;
  timezone: string;
  schedule: ScheduledGeneratorSchedule;
  mode?: "reminder" | "generate";
  topic?: string | null;
  reminder?: ScheduledGeneratorReminder | null;
  conversationId?: string | null;
}

export interface ScheduledGeneratorCreateRequest {
  previewId: string;
  semanticSignature: string;
  originalRequest: string;
  timezone: string;
  schedule: ScheduledGeneratorSchedule;
  mode?: "reminder" | "generate";
  topic?: string | null;
  reminder?: ScheduledGeneratorReminder | null;
  parsedIntent: ScheduledGeneratorParsedIntent;
  confirmedBrief: ScheduledGeneratorConfirmedBrief;
  duplicateAck?: boolean;
  similarTaskIdsSeen?: string[];
}

/** create resolves to the task, or — on a 409 — to the similar tasks the
 *  backend wants one more confirmation against (NOT thrown, it's a normal
 *  branch the caller surfaces to the user). */
export type ScheduledGeneratorCreateResult =
  | { ok: true; task: ScheduledGeneratorTask }
  | { ok: false; requiresConfirmation: true; similarTasks: ScheduledGeneratorTask[] };

export async function scheduledGeneratorPreview(
  req: ScheduledGeneratorPreviewRequest,
): Promise<ScheduledGeneratorPreview> {
  const res = await proxyPost("/scheduled-generators/preview", req);
  if (!res.ok)
    throw new Error(`scheduled generator preview failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function scheduledGeneratorCreate(
  req: ScheduledGeneratorCreateRequest,
): Promise<ScheduledGeneratorCreateResult> {
  const res = await proxyPost("/scheduled-generators", req);
  if (res.status === 409) {
    const body = await res.json();
    return { ok: false, requiresConfirmation: true, similarTasks: body.similarTasks ?? [] };
  }
  if (!res.ok)
    throw new Error(`scheduled generator create failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return { ok: true, task: body.task };
}

export async function listScheduledGenerators(
  includeArchived = false,
): Promise<ScheduledGeneratorTask[]> {
  const query = includeArchived ? "?includeArchived=true" : "";
  const res = await proxyFetch(`/scheduled-generators${query}`);
  if (!res.ok)
    throw new Error(`list scheduled generators failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.items ?? [];
}

export async function pauseScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyPost(`/scheduled-generators/${encodeURIComponent(taskId)}/pause`, {});
  if (!res.ok)
    throw new Error(`pause scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}

export async function resumeScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyPost(`/scheduled-generators/${encodeURIComponent(taskId)}/resume`, {});
  if (!res.ok)
    throw new Error(`resume scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}

export async function deleteScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyFetch(`/scheduled-generators/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!res.ok)
    throw new Error(`delete scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}
