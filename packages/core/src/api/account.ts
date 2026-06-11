import { proxyFetch } from "../transport/http";

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
