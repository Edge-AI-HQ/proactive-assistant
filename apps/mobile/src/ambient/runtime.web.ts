// Ambient 采集是 native-only：RN-web 预览形态下这些全是空壳占位，满足 runtime.ts
// 的导出契约让 web bundle 能起来（iOS 真机走 runtime.ts，不碰本文件）。
import type { RuntimeStatus } from "./status";

export function setAmbientTranscriptionLanguage(_language: string | null | undefined): void {
  // Ambient capture is native-only.
}

export function subscribeAmbientEnabled(_callback: () => void): () => void {
  return () => {};
}

export function getAmbientEnabledSnapshot(): boolean | null {
  return false;
}

export async function setAmbientEnabledFlag(_enabled: boolean): Promise<void> {
  // Ambient capture is native-only.
}

export async function isAmbientEnabled(): Promise<boolean> {
  return false;
}

export async function startAmbient(
  _userId: string,
  _opts: { interactivePermissions?: boolean } = {},
): Promise<string[]> {
  return [];
}

export async function stopAmbient(): Promise<void> {
  // Ambient capture is native-only.
}

export function ambientRunning(): boolean {
  return false;
}

export async function resumeAmbientIfEnabled(_userId: string): Promise<void> {
  // Ambient capture is native-only.
}

export async function reconcileEnabledSources(
  _userId: string,
  _keys: string[],
  _opts: { interactivePermissions?: boolean } = {},
): Promise<void> {
  // Ambient capture is native-only.
}

export async function flushAmbient(): Promise<void> {
  // Ambient capture is native-only.
}

export function ambientStatusSnapshot(): RuntimeStatus {
  return {
    sources: [],
    bufferSize: 0,
    outboxMode: "sqlite",
    outboxPendingCount: 0,
    totalIngested: 0,
    totalIngestErrors: 0,
    lastFlushTs: null,
    lastDrainTs: null,
    lastSuccessfulDrainTs: null,
    lastIngestError: null,
    uploadsLocked: false,
  };
}

export function subscribeAmbientStatus(_listener: () => void): () => void {
  return () => {};
}

export async function runScheduledTimelineSummary(_nowOverride?: Date): Promise<void> {
  // Ambient capture is native-only.
}

export async function runScheduledContextSnapshot(): Promise<void> {
  // Ambient capture is native-only.
}
