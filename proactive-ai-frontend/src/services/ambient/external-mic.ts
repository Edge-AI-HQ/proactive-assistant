import { AmbientAi } from "@pin/capacitor-ambient-ai";

import { isNative } from "@/lib/platform";

const LOG_PREFIX = "[ambient-power] external-mic";

/**
 * Coordinate the native ambient recorder with the chat-voice mic.
 *
 * Main-chat voice records through the WebView (getUserMedia / WebKit
 * SpeechRecognition), which seizes the shared iOS AVAudioSession and then
 * deactivates it on teardown — killing the native ambient AVAudioEngine with
 * no interruption notification, and nothing tells ambient to come back. These
 * two calls bracket every voice capture so ambient cleanly yields the session
 * before WebKit grabs it, and re-acquires it after.
 *
 * Suppression keeps the desired capture/classification state intact, so it is
 * a no-op when ambient is off. Resume is best-effort: the native side restarts
 * on un-suppress, and the JS source watchdog retries if that restart loses the
 * race with WebKit's async session release.
 */
export async function pauseAmbientForExternalMic(): Promise<void> {
  if (!isNative) return;
  try {
    await AmbientAi.audio.setExternalMicSuppressed({ suppressed: true });
  } catch (err) {
    console.warn(`${LOG_PREFIX} pause failed`, err);
  }
}

export async function resumeAmbientAfterExternalMic(): Promise<void> {
  if (!isNative) return;
  try {
    await AmbientAi.audio.setExternalMicSuppressed({ suppressed: false });
  } catch (err) {
    console.warn(`${LOG_PREFIX} resume failed`, err);
  }
}
