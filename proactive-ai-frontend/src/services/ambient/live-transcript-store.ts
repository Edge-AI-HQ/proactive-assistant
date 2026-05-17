import {
  appendLiveTranscript,
  type LiveSessionData,
  type LiveTranscriptUpdate,
} from "./live-session";

type Listener = () => void;

const LISTENING_TEXT = "Listening...";
const LISTENING_SESSION_ID = "ambient-live-listening";

let current: LiveSessionData | null = null;
const listeners = new Set<Listener>();

export function getAmbientLiveTranscriptSnapshot(): LiveSessionData | null {
  return current;
}

export function subscribeAmbientLiveTranscript(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function showAmbientListening(receivedAt = Date.now()): void {
  applyAmbientLiveTranscriptUpdate({
    captureSessionId: current?.captureSessionId ?? LISTENING_SESSION_ID,
    id: "listening",
    text: LISTENING_TEXT,
    source: "microphone",
    receivedAt,
  });
}

export function applyAmbientLiveTranscriptUpdate(update: LiveTranscriptUpdate): void {
  if (!update.text.trim()) return;
  current = appendLiveTranscript(current, update);
  notify();
}

export function resetAmbientLiveTranscriptForTest(): void {
  current = null;
  listeners.clear();
}

function notify(): void {
  for (const listener of listeners) listener();
}
