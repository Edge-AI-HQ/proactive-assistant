import { App } from "@capacitor/app";
import { isNative } from "@/lib/platform";
import {
  getAmbientRuntime,
  getExistingAmbientRuntime,
  shutdownAmbientRuntime,
  type RuntimeStatus,
  type SourceKey,
} from "./index";

let bound = false;
const POWER_LOG_PREFIX = "[ambient-power]";

/**
 * Bind the outbox drain to Capacitor's appStateChange. Drain is always
 * safe — it only flushes already-queued events, never starts a source.
 * Privacy invariant: this MUST NOT start any source on its own.
 */
export function bindAmbientLifecycle(): void {
  if (bound || !isNative) return;
  bound = true;

  App.addListener("appStateChange", ({ isActive }) => {
    const rt = getExistingAmbientRuntime();
    if (!rt) {
      console.info(`${POWER_LOG_PREFIX} appStateChange skipped; no ambient runtime`, { isActive });
      return;
    }
    if (isActive) {
      void (async () => {
        await rt.refreshActiveSources();
        await rt.drain();
      })();
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
 * runtime source state; ``AmbientSourcesPanel`` uses the same runtime
 * reconciliation after a per-source settings PATCH.
 *
 * Empty list → shut down sources and runtime timers; no drain is scheduled.
 */
export function startAmbientUpload(opts: {
  enabledSources?: SourceKey[];
  transcriptionLanguage?: string | null;
} = {}): Promise<RuntimeStatus | null> {
  if (!isNative) return Promise.resolve(null);
  const enabledSources = opts.enabledSources ?? [];
  if (enabledSources.length === 0) {
    console.info(`${POWER_LOG_PREFIX} ambient disabled; shutting down runtime`);
    return shutdownAmbientRuntime("empty-enabled-sources").then(() => null);
  }
  const runtime = getAmbientRuntime();
  runtime.setTranscriptionLanguage(opts.transcriptionLanguage ?? null);
  return (async () => {
    await runtime.reconcileEnabledSources(enabledSources);
    await runtime.drain();
    return runtime.status();
  })();
}

/**
 * Stop all ambient sources (without remembering as opt-out — we treat
 * "user revoked consent" as deferred to server settings, not local
 * cache). Used on logout or when the user disables all ambient capture.
 */
export async function stopAmbientUpload(): Promise<void> {
  if (!isNative) return;
  await shutdownAmbientRuntime("stopAmbientUpload");
}
