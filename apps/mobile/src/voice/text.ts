export function appendVoiceTranscript(base: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return base;
  if (!base.trim()) return text;
  const needsSpace = !/\s$/.test(base) && !/^[,.;!?，。！？、；：）)\]}]/.test(text);
  return `${base}${needsSpace ? " " : ""}${text}`;
}
