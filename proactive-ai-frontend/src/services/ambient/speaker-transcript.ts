export interface SpeakerTranscriptSegment {
  speaker: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
}

interface NormalizedSpeakerSegment {
  speaker: string;
  text: string;
}

export function speakerAwareTranscriptTextFromPayload(
  payload: Record<string, unknown>,
  fallbackText: string,
): string {
  return speakerAwareTranscriptText(payload.speaker_segments, fallbackText);
}

export function speakerAwareTranscriptText(
  speakerSegments: unknown,
  fallbackText: string,
): string {
  const segments = normalizeSpeakerSegments(speakerSegments);
  if (segments.length === 0) return fallbackText.trim();
  return mergeAdjacentSpeakerSegments(segments)
    .map((segment) => `${segment.speaker}: ${JSON.stringify(segment.text)}`)
    .join("\n");
}

export function normalizeSpeakerSegments(value: unknown): SpeakerTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const speaker = cleanText(row.speaker);
    const text = cleanText(row.text);
    if (!speaker || !text) return [];
    return [{
      speaker,
      text,
      ...(typeof row.start_ms === "number" && Number.isFinite(row.start_ms)
        ? { start_ms: row.start_ms }
        : {}),
      ...(typeof row.end_ms === "number" && Number.isFinite(row.end_ms)
        ? { end_ms: row.end_ms }
        : {}),
    }];
  });
}

function mergeAdjacentSpeakerSegments(
  segments: NormalizedSpeakerSegment[],
): NormalizedSpeakerSegment[] {
  const out: NormalizedSpeakerSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (previous?.speaker === segment.speaker) {
      previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, " ").trim();
    } else {
      out.push({ ...segment });
    }
  }
  return out;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}
