import { AmbientAi } from "@pin/capacitor-ambient-ai";

import { isNative } from "@/lib/platform";

const LOG_PREFIX = "[ambient-power] external-mic";

/**
 * Coordinate the native ambient recorder with WebView mic capture — chat-voice
 * (getUserMedia / WebKit SpeechRecognition) and Settings voice-identity
 * enrollment. Both record through the WebView, which seizes the shared iOS
 * AVAudioSession and deactivates it on teardown — killing the native ambient
 * AVAudioEngine with no interruption notification, and nothing tells ambient to
 * come back.
 *
 * Every WebView capture brackets itself with a lease so ambient cleanly yields
 * the session before WebKit grabs it and re-acquires it after:
 *
 *   const lease = await acquireExternalMic();
 *   try { ...record... } finally { await lease.release(); }
 *
 * Design notes:
 * - Reference counted: concurrent holders only flip native suppression on the
 *   first acquire / last release.
 * - Serialized on a single promise chain: a `suppress` can never land after its
 *   matching `resume` even for very short captures. That ordering race is what
 *   the previous bare pause/resume pair was exposed to.
 * - Suppression keeps the desired capture/classification state intact, so this
 *   is a no-op when ambient is off. Resume stays best-effort end-to-end: the
 *   native side runs its own watchdog that auto-clears the suppression if a
 *   release is ever lost (page reload mid-capture, dropped bridge call).
 */

export interface ExternalMicLease {
  /** Hand the mic back to ambient. Idempotent — safe to call more than once. */
  release(): Promise<void>;
}

const NOOP_LEASE: ExternalMicLease = { release: async () => {} };

let holders = 0;
let chain: Promise<void> = Promise.resolve();

/**
 * Run `op` after everything already queued, regardless of prior outcome, so
 * suppress/resume always apply in call order. Errors are logged, not thrown:
 * acquire/release are best-effort, and one failed bridge call must not wedge
 * the chain or reject the caller.
 */
function enqueue(op: () => Promise<void>): Promise<void> {
  chain = chain.then(op, op).catch((err) => {
    console.warn(`${LOG_PREFIX} op failed`, err);
  });
  return chain;
}

/**
 * Yield the native ambient mic for the duration of a WebView capture. Returns a
 * lease whose `release()` hands the mic back. No-op (and a no-op lease) when not
 * running natively.
 */
export async function acquireExternalMic(): Promise<ExternalMicLease> {
  if (!isNative) return NOOP_LEASE;
  await enqueue(async () => {
    holders += 1;
    if (holders === 1) {
      await AmbientAi.audio.setExternalMicSuppressed({ suppressed: true });
    }
  });
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await enqueue(async () => {
        holders = Math.max(0, holders - 1);
        if (holders === 0) {
          await AmbientAi.audio.setExternalMicSuppressed({ suppressed: false });
        }
      });
    },
  };
}
