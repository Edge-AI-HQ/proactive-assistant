import { type Context } from 'grammy';
import {
  type OpenClawChatReply,
  type OpenClawReplyMessage
} from '../openclaw/client.js';
import { type ArtifactReference } from '../openclaw/artifacts.js';
import { parseReplyDirectives, normalizeArtifactSource } from './deliveryDirectives.js';
import { sendArtifact, sendTextReply } from './deliverySender.js';
import { chunkTelegramText } from './text.js';
import type { TelegramDeliveryUser } from './deliveryTypes.js';

const MAX_ARTIFACTS_PER_REPLY = 8;
const FORCE_AUDIO_AS_VOICE = true;

interface DeliverOpenClawReplyOptions {
  skipText?: boolean;
  suppressEmptyFallback?: boolean;
}

const dedupeArtifacts = (artifacts: ArtifactReference[]): ArtifactReference[] => {
  const map = new Map<string, ArtifactReference>();
  artifacts.forEach((artifact) => {
    const source = normalizeArtifactSource(artifact.source);
    if (!source) return;

    const existing = map.get(source);
    if (!existing || (existing.kind === 'file' && artifact.kind === 'media')) {
      map.set(source, { source, kind: artifact.kind });
    }
  });
  return Array.from(map.values());
};

const toReplyMessages = (reply: OpenClawChatReply): OpenClawReplyMessage[] => {
  if (Array.isArray(reply.messages) && reply.messages.length > 0) {
    return reply.messages;
  }
  return [{ text: reply.text }];
};

const messageArtifacts = (message: OpenClawReplyMessage): ArtifactReference[] => {
  const artifacts: ArtifactReference[] = [];
  if (typeof message.mediaUrl === 'string' && message.mediaUrl.trim()) {
    artifacts.push({
      source: message.mediaUrl,
      kind: 'media'
    });
  }

  message.mediaUrls?.forEach((mediaUrl) => {
    if (!mediaUrl.trim()) return;
    artifacts.push({
      source: mediaUrl,
      kind: 'media'
    });
  });

  return artifacts;
};

export const deliverOpenClawReply = async (
  ctx: Context,
  user: TelegramDeliveryUser,
  reply: OpenClawChatReply,
  options?: DeliverOpenClawReplyOptions
): Promise<void> => {
  const replyMessages = toReplyMessages(reply);
  let delivered = false;
  const deliveredSources = new Set<string>();

  for (const message of replyMessages) {
    const parsed = parseReplyDirectives(message.text ?? '');
    const wantsVoice = FORCE_AUDIO_AS_VOICE || Boolean(message.audioAsVoice || parsed.wantsVoice);
    const parsedArtifacts: ArtifactReference[] = parsed.mediaSources.map((source) => ({
      source,
      kind: 'media'
    }));
    const artifacts = dedupeArtifacts([...messageArtifacts(message), ...parsedArtifacts]);

    if (parsed.text && !options?.skipText) {
      const textChunks = chunkTelegramText(parsed.text);
      for (const chunk of textChunks) {
        await sendTextReply(ctx, chunk);
        delivered = true;
      }
    }

    for (const artifact of artifacts.slice(0, MAX_ARTIFACTS_PER_REPLY)) {
      const ok = await sendArtifact(ctx, user, artifact, { asVoice: wantsVoice }).catch(() => false);
      if (!ok) continue;
      delivered = true;
      deliveredSources.add(normalizeArtifactSource(artifact.source));
    }

    if (artifacts.length > MAX_ARTIFACTS_PER_REPLY) {
      await ctx.reply(`There are ${artifacts.length - MAX_ARTIFACTS_PER_REPLY} more artifacts not shown.`);
      delivered = true;
    }
  }

  const trailingArtifacts = dedupeArtifacts(
    reply.artifacts.filter((artifact) => !deliveredSources.has(normalizeArtifactSource(artifact.source)))
  );

  for (const artifact of trailingArtifacts.slice(0, MAX_ARTIFACTS_PER_REPLY)) {
    const ok = await sendArtifact(ctx, user, artifact, { asVoice: FORCE_AUDIO_AS_VOICE }).catch(() => false);
    delivered = delivered || ok;
  }

  if (trailingArtifacts.length > MAX_ARTIFACTS_PER_REPLY) {
    await ctx.reply(`There are ${trailingArtifacts.length - MAX_ARTIFACTS_PER_REPLY} more artifacts not shown.`);
    delivered = true;
  }

  if (!delivered && !options?.suppressEmptyFallback) {
    await ctx.reply('(empty response)');
  }
};
