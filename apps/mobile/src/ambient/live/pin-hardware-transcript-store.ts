import AsyncStorage from "@react-native-async-storage/async-storage";

import type { PinHardwareTranscriptEvent } from "../../../modules/pin-hardware";

type Listener = () => void;

const STORAGE_KEY_PREFIX = "pinai:pin-hardware-transcripts:";
const STORAGE_VERSION = 1;
const MAX_TRANSCRIPTS = 120;
const TRANSCRIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
  capturedAt: string;
  provider?: string;
  marked?: boolean;
  pending?: boolean;
  placeholder?: boolean;
}

interface StoredTranscriptHistory {
  version: typeof STORAGE_VERSION;
  savedAt: number;
  expiresAt: number;
  lines: TranscriptLine[];
}

let current: TranscriptLine[] = [];
let ownerUserId: string | null = null;
let ownerGeneration = 0;
let hydrationPromise: Promise<void> | null = null;
let revision = 0;
let persistenceTail: Promise<void> = Promise.resolve();
const listeners = new Set<Listener>();

export function getPinHardwareTranscriptSnapshot(): TranscriptLine[] {
  return current;
}

export function subscribePinHardwareTranscripts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Select the signed-in owner and hydrate their durable final transcript lines.
 * The in-memory stream stays page-independent, while the storage key prevents
 * transcript history from crossing account boundaries on a shared device.
 */
export function setPinHardwareTranscriptOwner(userId: string): Promise<void> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return Promise.resolve();
  if (ownerUserId === normalizedUserId && hydrationPromise) return hydrationPromise;
  if (ownerUserId === normalizedUserId) return Promise.resolve();

  ownerUserId = normalizedUserId;
  const generation = ++ownerGeneration;
  const startingRevision = revision;
  current = [];
  revision += 1;
  notify();

  hydrationPromise = (async () => {
    // Finish writes captured for a previous owner before reading the new key.
    await persistenceTail;
    let storedLines: TranscriptLine[] = [];
    try {
      const raw = await AsyncStorage.getItem(storageKey(normalizedUserId));
      storedLines = parseStoredHistory(raw);
      if (raw && storedLines.length === 0) {
        await AsyncStorage.removeItem(storageKey(normalizedUserId));
      }
    } catch {
      // A storage failure must not block the live transcript stream.
    }
    if (ownerUserId !== normalizedUserId || ownerGeneration !== generation) return;

    // Native events can arrive while AsyncStorage is hydrating. Keep those
    // events and merge the older durable lines behind the same stable ids.
    current = revision === startingRevision + 1
      ? storedLines
      : mergeTranscriptLines(storedLines, current);
    revision += 1;
    notify();
  })().finally(() => {
    if (ownerGeneration === generation) hydrationPromise = null;
  });
  return hydrationPromise;
}

/** Apply every native event, including interim updates, to the shared UI store. */
export function applyPinHardwareTranscriptEvent(event: PinHardwareTranscriptEvent): void {
  const beforePersisted = persistedFingerprint(current);
  const next = mergeTranscriptEvent(current, event);
  if (next === current) return;
  current = next;
  revision += 1;
  notify();
  if (persistedFingerprint(current) !== beforePersisted) schedulePersistence();
}

export function togglePinHardwareTranscriptMark(lineId: string): void {
  let changed = false;
  const next = current.map((line) => {
    if (line.id !== lineId) return line;
    changed = true;
    return { ...line, marked: line.marked !== true };
  });
  if (!changed) return;
  current = next;
  revision += 1;
  notify();
  schedulePersistence();
}

/**
 * Clear device-global memory during sign-out. The caller removes all `pinai:*`
 * keys after this resolves; waiting for queued writes closes the write/sweep race.
 */
export async function clearPinHardwareTranscriptHistory(): Promise<void> {
  ownerUserId = null;
  ownerGeneration += 1;
  hydrationPromise = null;
  current = [];
  revision += 1;
  notify();
  await persistenceTail;
}

/**
 * Merge by provider session + slice id so interim results update in place and a
 * restarted ASR session cannot overwrite an earlier finalized sentence.
 */
export function mergeTranscriptEvent(
  prev: TranscriptLine[],
  event: PinHardwareTranscriptEvent,
): TranscriptLine[] {
  const capturedAt = event.capturedAt;
  const diarized = (event.segments ?? []).filter(
    (segment) => segment.text.trim().length > 0
      && (segment.sentenceId != null || segment.speakerLabel || segment.speakerId),
  );
  if (diarized.length > 0) {
    let next = prev;
    diarized.forEach((segment, index) => {
      const text = segment.text.trim();
      const segmentKey = segment.sentenceId != null
        ? `${event.voiceId ?? "s0"}:${segment.sentenceId}`
        : event.sliceIndex != null
          ? `${event.voiceId ?? "s0"}:${event.sliceIndex}:${index}`
          : `${capturedAt}:${index}:${text}`;
      next = upsertTranscriptLine(next, {
        id: `pin:seg:${event.deviceId ?? "unknown"}:${segmentKey}`,
        speaker: pinHardwareSpeakerLabel(segment.speakerId, segment.speakerLabel),
        text,
        capturedAt,
        provider: event.provider,
        pending: segment.isFinal === false,
      });
    });
    return next;
  }

  const text = event.text.trim();
  if (!text) return prev;
  const key = event.sliceIndex != null
    ? `pin:${event.deviceId ?? "unknown"}:${event.voiceId ?? "s0"}:${event.sliceIndex}`
    : `pin:${capturedAt}:${text}`;
  return upsertTranscriptLine(prev, {
    id: key,
    speaker: "Speaker A",
    text,
    capturedAt,
    provider: event.provider,
    pending: !event.isFinal,
  });
}

/** Stable product labels for Tencent's anonymous speaker ids. */
export function pinHardwareSpeakerLabel(
  speakerId?: string,
  speakerLabel?: string,
): string {
  const explicit = speakerLabel?.trim();
  if (explicit) return explicit;
  const normalized = speakerId?.trim();
  if (!normalized) return "PINAI";
  const numericId = Number(normalized);
  if (!Number.isInteger(numericId)) return `Speaker ${normalized}`;
  if (numericId < 0) return "Speaker ?";
  if (numericId < 26) return `Speaker ${String.fromCharCode(65 + numericId)}`;
  return `Speaker ${numericId + 1}`;
}

function upsertTranscriptLine(prev: TranscriptLine[], line: TranscriptLine): TranscriptLine[] {
  const existingIndex = prev.findIndex((existing) => existing.id === line.id);
  if (existingIndex >= 0) {
    const existing = prev[existingIndex];
    // Provider finals are terminal for a slice. Ignore a delayed interim event
    // instead of downgrading (and deleting) an already durable sentence.
    if (existing.pending !== true && line.pending === true) return prev;
    if (
      existing.text === line.text
      && existing.speaker === line.speaker
      && existing.pending === line.pending
      && existing.capturedAt === line.capturedAt
      && existing.provider === line.provider
    ) {
      return prev;
    }
    const next = prev.slice();
    // Tencent re-sends the full speaker snapshot while the latest sentence
    // changes. Keep the first timestamp stable so existing rows do not look
    // like newly created lines on every interim update.
    next[existingIndex] = {
      ...line,
      capturedAt: existing.capturedAt,
      marked: existing.marked,
    };
    return next;
  }
  return [...prev, line].slice(-MAX_TRANSCRIPTS);
}

function schedulePersistence(): void {
  const userId = ownerUserId;
  if (!userId) return;
  const lines = persistableLines(current);
  const now = Date.now();
  const payload: StoredTranscriptHistory = {
    version: STORAGE_VERSION,
    savedAt: now,
    expiresAt: now + TRANSCRIPT_TTL_MS,
    lines,
  };
  const key = storageKey(userId);
  persistenceTail = persistenceTail
    .catch(() => {})
    .then(() => AsyncStorage.setItem(key, JSON.stringify(payload)))
    .catch(() => {});
}

function persistableLines(lines: TranscriptLine[]): TranscriptLine[] {
  const cutoff = Date.now() - TRANSCRIPT_TTL_MS;
  return lines
    .filter((line) => !line.pending && !line.placeholder && line.text.trim().length > 0)
    .filter((line) => {
      const capturedAt = Date.parse(line.capturedAt);
      return !Number.isFinite(capturedAt) || capturedAt >= cutoff;
    })
    .slice(-MAX_TRANSCRIPTS)
    .map(({ pending: _pending, placeholder: _placeholder, ...line }) => line);
}

function persistedFingerprint(lines: TranscriptLine[]): string {
  return JSON.stringify(persistableLines(lines));
}

function parseStoredHistory(raw: string | null): TranscriptLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTranscriptHistory>;
    if (parsed.version !== STORAGE_VERSION || typeof parsed.expiresAt !== "number") return [];
    if (parsed.expiresAt <= Date.now() || !Array.isArray(parsed.lines)) return [];
    return parsed.lines.flatMap((value) => {
      if (!isStoredTranscriptLine(value)) return [];
      return [{
        id: value.id,
        speaker: value.speaker,
        text: value.text,
        capturedAt: value.capturedAt,
        ...(value.provider ? { provider: value.provider } : {}),
        ...(value.marked === true ? { marked: true } : {}),
      }];
    }).slice(-MAX_TRANSCRIPTS);
  } catch {
    return [];
  }
}

function isStoredTranscriptLine(value: unknown): value is TranscriptLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<TranscriptLine>;
  return typeof line.id === "string"
    && typeof line.speaker === "string"
    && typeof line.text === "string"
    && line.text.trim().length > 0
    && typeof line.capturedAt === "string"
    && (line.provider == null || typeof line.provider === "string")
    && (line.marked == null || typeof line.marked === "boolean")
    && line.pending !== true
    && line.placeholder !== true;
}

function mergeTranscriptLines(
  stored: TranscriptLine[],
  live: TranscriptLine[],
): TranscriptLine[] {
  const merged = new Map<string, TranscriptLine>();
  for (const line of stored) merged.set(line.id, line);
  for (const line of live) merged.set(line.id, line);
  return Array.from(merged.values()).slice(-MAX_TRANSCRIPTS);
}

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}
