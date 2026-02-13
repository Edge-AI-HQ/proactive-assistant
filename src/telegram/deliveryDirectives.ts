const AUDIO_AS_VOICE_MARKER_RE = /\[\[\s*audio_as_voice\s*\]\]/i;
const AUDIO_AS_VOICE_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;

export interface ParsedReplyDirectives {
  text: string;
  wantsVoice: boolean;
  mediaSources: string[];
}

export const normalizeArtifactSource = (raw: string): string => {
  return raw
    .trim()
    .replace(/^[`"'[{(<]+/, '')
    .replace(/[`"'}),\].;:!?<>]+$/, '');
};

const maybeUnwrapQuoted = (value: string): string => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== last) return value;
  if (first !== '"' && first !== "'" && first !== '`') return value;
  return value.slice(1, -1);
};

const parseMediaDirectives = (rawText: string): { text: string; mediaSources: string[] } => {
  const lines = rawText.split(/\r?\n/);
  const kept: string[] = [];
  const mediaSources: string[] = [];

  for (const line of lines) {
    const mediaLine = line.match(/^\s*MEDIA:\s*(.+?)\s*$/i);
    if (!mediaLine) {
      kept.push(line);
      continue;
    }

    const payload = mediaLine[1]?.trim() ?? '';
    if (!payload) {
      continue;
    }

    const source = normalizeArtifactSource(maybeUnwrapQuoted(payload));
    if (!source) {
      kept.push(line);
      continue;
    }

    mediaSources.push(source.startsWith('file://') ? source.slice('file://'.length) : source);
  }

  return {
    text: kept.join('\n').trim(),
    mediaSources
  };
};

export const parseReplyDirectives = (rawText: string): ParsedReplyDirectives => {
  const wantsVoice = AUDIO_AS_VOICE_MARKER_RE.test(rawText);
  const withoutAudioTag = rawText.replace(AUDIO_AS_VOICE_RE, '').trim();
  const parsedMedia = parseMediaDirectives(withoutAudioTag);

  return {
    text: parsedMedia.text,
    wantsVoice,
    mediaSources: parsedMedia.mediaSources
  };
};
