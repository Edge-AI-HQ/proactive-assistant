import { getSelectedAmbientSummaryModelId } from "../models-selection";
import type { AmbientCandidateWindow, AmbientTimelineEvent } from "./types";

export interface AmbientTimelineEventDraft {
  eventType: AmbientTimelineEvent["eventType"];
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: AmbientTimelineEvent["confidenceLabel"];
  salientFacts: string[];
  actionCandidates?: string[];
  memoryCandidates?: string[];
  possibleCardTrigger?: {
    title: string;
    reason: string;
  };
}

export interface AmbientWindowSummary {
  summary: string;
  confidence: number;
  salientFacts: string[];
}

export interface AmbientTimelineModelBridge {
  summarizeWindow(window: AmbientCandidateWindow): Promise<AmbientWindowSummary | null>;
  generateTimelineEvent(
    window: AmbientCandidateWindow,
  ): Promise<AmbientTimelineEventDraft | null>;
}

interface NativeModelProfile {
  id: string;
  kind: string;
}

interface NativeModelStatus {
  id: string;
  state: string;
  lastVerifyResult?: string;
}

interface NativeModelsApi {
  list(): Promise<{ profiles: NativeModelProfile[]; statuses: NativeModelStatus[] }>;
  generateTimelineEvent(options: {
    modelId: string;
    window: Record<string, unknown>;
  }): Promise<unknown>;
}

const EVENT_TYPES: AmbientTimelineEvent["eventType"][] = [
  "morning",
  "visit",
  "transition",
  "conversation",
  "meeting",
  "focus",
  "workout",
  "health",
  "social",
  "other",
];

export function createAmbientTimelineModelBridge(): AmbientTimelineModelBridge {
  return new NativeAmbientTimelineModelBridge();
}

class NativeAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineEvent(
    window: AmbientCandidateWindow,
  ): Promise<AmbientTimelineEventDraft | null> {
    const modelId = getSelectedAmbientSummaryModelId();
    if (!modelId) return null;
    try {
      const api = await loadNativeModelsApi();
      if (!await isSelectedModelReady(api, modelId)) return null;
      const draft = await api.generateTimelineEvent({
        modelId,
        window: modelWindowPayload(window),
      });
      return normalizeDraft(draft);
    } catch {
      return null;
    }
  }
}

class NoopAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineEvent(): Promise<AmbientTimelineEventDraft | null> {
    return null;
  }
}

export const ambientTimelineModels: AmbientTimelineModelBridge =
  createAmbientTimelineModelBridge();

async function loadNativeModelsApi(): Promise<NativeModelsApi> {
  const mod = await import("@pin/capacitor-ambient-ai") as unknown as {
    AmbientAi?: { models?: NativeModelsApi };
  };
  if (!mod.AmbientAi?.models) throw new Error("AmbientModels unavailable");
  return mod.AmbientAi.models;
}

async function isSelectedModelReady(api: NativeModelsApi, modelId: string): Promise<boolean> {
  const result = await api.list();
  const profile = result.profiles.find((item) => item.id === modelId);
  const status = result.statuses.find((item) => item.id === modelId);
  return profile?.kind === "llm"
    && status?.state === "present"
    && status.lastVerifyResult === "ok";
}

function modelWindowPayload(window: AmbientCandidateWindow): Record<string, unknown> {
  return {
    id: window.id,
    localDate: window.localDate,
    timezone: window.timezone,
    windowType: window.windowType,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    sourceTypes: window.sourceTypes,
    deviceLabels: window.deviceLabels,
    compactContext: window.compactContext,
    privacyHint: window.privacyHint,
    confidenceHint: window.confidenceHint,
    salienceHint: window.salienceHint,
    schemaVersion: "ambient_candidate_window.v1",
  };
}

function normalizeDraft(value: unknown): AmbientTimelineEventDraft | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const eventType = EVENT_TYPES.includes(row.eventType as AmbientTimelineEvent["eventType"])
    ? row.eventType as AmbientTimelineEvent["eventType"]
    : null;
  const title = shortText(row.title, 80);
  const summary = shortText(row.summary, 220);
  if (!eventType || !title || !summary) return null;
  const confidence = clamp01(typeof row.confidence === "number" ? row.confidence : 0.5);
  const confidenceLabel = row.confidenceLabel === "certain" || row.confidenceLabel === "uncertain"
    ? row.confidenceLabel
    : confidence >= 0.65 ? "certain" : "uncertain";
  return {
    eventType,
    title,
    summary,
    tags: stringArray(row.tags).map((tag) => tag.slice(0, 32)).slice(0, 6),
    confidence,
    confidenceLabel,
    salientFacts: stringArray(row.salientFacts).slice(0, 6),
  };
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1).trimEnd() + "…";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
