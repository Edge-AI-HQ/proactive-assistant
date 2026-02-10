export type ArtifactKind = 'media' | 'file';

export interface ArtifactReference {
  source: string;
  kind: ArtifactKind;
}

const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|mp3|wav|ogg|opus|m4a|aac)$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const cleanSource = (value: string): string => value.trim();

const isMediaSource = (value: string): boolean => MEDIA_EXT_RE.test(value);

const toArtifact = (source: string): ArtifactReference | null => {
  const cleaned = cleanSource(source);
  if (!cleaned) return null;
  return {
    source: cleaned,
    kind: isMediaSource(cleaned) ? 'media' : 'file'
  };
};

const upsertArtifact = (store: Map<string, ArtifactReference>, artifact: ArtifactReference): void => {
  const existing = store.get(artifact.source);
  if (!existing || (existing.kind === 'file' && artifact.kind === 'media')) {
    store.set(artifact.source, artifact);
  }
};

const collectFromNode = (node: unknown, store: Map<string, ArtifactReference>): void => {
  if (!isRecord(node)) return;

  if (typeof node.mediaUrl === 'string') {
    const artifact = toArtifact(node.mediaUrl);
    if (artifact) upsertArtifact(store, artifact);
  }

  if (Array.isArray(node.mediaUrls)) {
    for (const entry of node.mediaUrls) {
      if (typeof entry !== 'string') continue;
      const artifact = toArtifact(entry);
      if (artifact) upsertArtifact(store, artifact);
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectFromNode(item, store);
      }
      continue;
    }
    if (isRecord(value)) {
      collectFromNode(value, store);
    }
  }
};

export const extractArtifactReferences = (value: unknown): ArtifactReference[] => {
  const store = new Map<string, ArtifactReference>();
  collectFromNode(value, store);
  return Array.from(store.values());
};

export const looksLikeContainerPath = (source: string): boolean => {
  return (
    source.startsWith('/app/data/') ||
    source.startsWith('/tmp/') ||
    source.startsWith('/root/.openclaw/workspace/')
  );
};
