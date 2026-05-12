import { App } from "@capacitor/app";
import { isNative } from "@/lib/platform";
import { getAmbientRuntime, type SourceKey } from "./index";

let bound = false;

/**
 * Bind the outbox drain to Capacitor's appStateChange. Drain is always
 * safe — it only flushes already-queued events, never starts a source.
 * Privacy invariant: this MUST NOT start any source on its own.
 */
export function bindAmbientLifecycle(): void {
  if (bound || !isNative) return;
  bound = true;

  App.addListener("appStateChange", ({ isActive }) => {
    const rt = getAmbientRuntime();
    if (isActive) {
      void rt.drain();
      return;
    }
    void rt.drain().catch(() => {
      /* runtime records lastIngestError */
    });
  }).catch(() => {
    /* listener registration failure is non-fatal */
  });
}

/**
 * Reconcile the ambient runtime to the user's opt-in set. Sources in
 * ``enabledSources`` that aren't running yet are started; sources
 * currently running but not in the list are stopped. Then drain the
 * outbox once so anything already queued gets flushed.
 *
 * Idempotent — safe to call on every settings change. NEVER calls
 * ``runtime.autoStart()`` (privacy invariant per V3 migration plan
 * D-5 / Step 3). This is the single SPA entry point that drives
 * runtime source state; ``AmbientSourcesPanel``'s reconcile effect is
 * a no-op convenience when the panel happens to be mounted.
 *
 * Empty list → stop everything and only drain.
 */
export function startAmbientUpload(opts: {
  enabledSources?: SourceKey[];
} = {}): void {
  if (!isNative) return;
  const runtime = getAmbientRuntime();
  const wanted = new Set(opts.enabledSources ?? []);
  void (async () => {
    for (const src of runtime.status().sources) {
      const shouldRun = wanted.has(src.key);
      if (shouldRun && !src.enabled) {
        try { await runtime.start(src.key); } catch { /* lastError on status */ }
      } else if (!shouldRun && src.enabled) {
        try { await runtime.stop(src.key, { remember: false }); } catch { /* */ }
      }
    }
    await runtime.drain();
  })();
}

/**
 * Stop all ambient sources (without remembering as opt-out — we treat
 * "user revoked consent" as deferred to server settings, not local
 * cache). Used on logout or when the user disables all ambient capture.
 */
export async function stopAmbientUpload(): Promise<void> {
  if (!isNative) return;
  const runtime = getAmbientRuntime();
  await runtime.stopAll();
}
