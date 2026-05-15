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

class NoopAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineEvent(): Promise<AmbientTimelineEventDraft | null> {
    return null;
  }
}

export const ambientTimelineModels: AmbientTimelineModelBridge =
  new NoopAmbientTimelineModelBridge();
