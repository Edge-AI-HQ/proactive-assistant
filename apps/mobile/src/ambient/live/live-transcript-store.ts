/**
 * RN 实时转写内存 store —— dev services/ambient/live-transcript-store.ts 的移植版。
 * 累积当前 capture session 的实时转写消息 + 轮换时归档到 history。逻辑与 dev 一致，
 * 仅把 CaptureSessionRotatedEvent 的来源从 Capacitor 换成 RN transcript-listener。
 */
import {
  appendLiveTranscript,
  type LiveHistoryTranscript,
  type LiveSessionData,
  type LiveTranscriptUpdate,
} from "./live-session";
import type { CaptureSessionRotatedEvent } from "./transcript-listener";

type Listener = () => void;

const LISTENING_TEXT = "Listening...";
const LISTENING_SESSION_ID = "ambient-live-listening";
const MAX_LOCAL_HISTORY = 5;

let current: LiveSessionData | null = null;
let history: LiveHistoryTranscript[] = [];
const listeners = new Set<Listener>();

export function getAmbientLiveTranscriptSnapshot(): LiveSessionData | null {
  return current;
}

export function getAmbientLiveTranscriptHistorySnapshot(): LiveHistoryTranscript[] {
  return history;
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

export function applyCaptureSessionRotation(event: CaptureSessionRotatedEvent): void {
  if (!current || current.captureSessionId !== event.oldCaptureSessionId) return;
  const rotatedAtMs = Date.parse(event.rotatedAt);
  const fallbackAt = Number.isFinite(rotatedAtMs) ? rotatedAtMs : Date.now();
  const moved = current.messages
    .filter((message) => message.id !== "listening")
    .filter((message) => message.text.trim() !== LISTENING_TEXT)
    .map((message) => ({
      id: message.id,
      captureSessionId: current?.captureSessionId ?? event.oldCaptureSessionId,
      occurredAt: new Date(message.sortTs ?? fallbackAt).toISOString(),
      text: message.text,
      source: message.source,
    }));
  history = dedupeHistory([...moved.reverse(), ...history]).slice(0, MAX_LOCAL_HISTORY);
  current = null;
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

function dedupeHistory(items: LiveHistoryTranscript[]): LiveHistoryTranscript[] {
  const seen = new Set<string>();
  const unique: LiveHistoryTranscript[] = [];
  for (const item of items) {
    const key = `${item.captureSessionId}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}
