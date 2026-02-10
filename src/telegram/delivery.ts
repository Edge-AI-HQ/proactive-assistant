import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { InputFile, type Context } from 'grammy';
import { getUserContainerDirs, resolveContainerPathForUser } from '../docker/manager.js';
import type { UserRecord } from '../types.js';
import {
  type OpenClawChatReply,
  type OpenClawReplyMessage
} from '../openclaw/client.js';
import { type ArtifactReference, looksLikeContainerPath } from '../openclaw/artifacts.js';
import { renderTelegramHtmlFromMarkdown } from './format.js';

const AUDIO_AS_VOICE_MARKER_RE = /\[\[\s*audio_as_voice\s*\]\]/i;
const AUDIO_AS_VOICE_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const MAX_TEXT_CHUNK = 3900;
const MAX_ARTIFACTS_PER_REPLY = 8;
const MAX_TEXT_PREVIEW_BYTES = 200_000;
const VOICE_TRANSCODE_TIMEOUT_MS = 45_000;
const FORCE_AUDIO_AS_VOICE = true;
const TELEGRAM_PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity/i;

type TelegramUser = Pick<UserRecord, 'telegram_user_id' | 'container_port' | 'container_id'>;

interface ParsedReplyDirectives {
  text: string;
  wantsVoice: boolean;
  mediaSources: string[];
}

interface PreparedVoiceFile {
  file: InputFile;
  cleanup: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const normalizePathForExtCheck = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    return parsed.pathname || trimmed;
  } catch {
    return trimmed.split(/[?#]/g)[0] ?? trimmed;
  }
};

const isImagePath = (value: string): boolean =>
  /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(normalizePathForExtCheck(value));

const isAudioPath = (value: string): boolean =>
  /\.(mp3|wav|ogg|opus|m4a|aac)$/i.test(normalizePathForExtCheck(value));

const isVideoPath = (value: string): boolean =>
  /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(normalizePathForExtCheck(value));

const isVoiceCompatibleAudio = (value: string): boolean =>
  /\.(ogg|opus)$/i.test(normalizePathForExtCheck(value));

const isTextPath = (value: string): boolean =>
  /\.(txt|md|json|csv|ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|yaml|yml|toml|xml|html|css|log|sql)$/i.test(
    normalizePathForExtCheck(value)
  );

const normalizeArtifactValue = (raw: string): string => {
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

    const source = normalizeArtifactValue(maybeUnwrapQuoted(payload));
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

const parseReplyDirectives = (rawText: string): ParsedReplyDirectives => {
  const wantsVoice = AUDIO_AS_VOICE_MARKER_RE.test(rawText);
  const withoutAudioTag = rawText.replace(AUDIO_AS_VOICE_RE, '').trim();
  const parsedMedia = parseMediaDirectives(withoutAudioTag);

  return {
    text: parsedMedia.text,
    wantsVoice,
    mediaSources: parsedMedia.mediaSources
  };
};

const prepareVoiceFile = async (hostPath: string): Promise<PreparedVoiceFile | null> => {
  if (isVoiceCompatibleAudio(hostPath)) {
    return {
      file: new InputFile(hostPath),
      cleanup: async () => undefined
    };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pinai-voice-'));
  const outputPath = path.join(tempDir, `${path.parse(hostPath).name}-${Date.now()}.ogg`);

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        hostPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        outputPath
      ],
      {
        timeout: VOICE_TRANSCODE_TIMEOUT_MS
      }
    );

    const stats = await fs.promises.stat(outputPath);
    if (stats.size <= 0) {
      throw new Error('ffmpeg produced empty voice file');
    }

    return {
      file: new InputFile(outputPath),
      cleanup: async () => {
        await fs.promises.rm(tempDir, {
          recursive: true,
          force: true
        });
      }
    };
  } catch {
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    });
    return null;
  }
};

const sendTextReply = async (ctx: Context, text: string): Promise<void> => {
  const html = renderTelegramHtmlFromMarkdown(text);
  try {
    await ctx.reply(html, {
      parse_mode: 'HTML'
    });
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!TELEGRAM_PARSE_ERROR_RE.test(message)) {
      throw error;
    }
  }
  await ctx.reply(text);
};

const chunkText = (text: string): string[] => {
  if (text.length <= MAX_TEXT_CHUNK) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next = Math.min(cursor + MAX_TEXT_CHUNK, text.length);
    if (next < text.length) {
      const newline = text.lastIndexOf('\n', next);
      if (newline > cursor + 800) {
        next = newline;
      }
    }
    chunks.push(text.slice(cursor, next).trim());
    cursor = next;
  }

  return chunks.filter(Boolean);
};

const dedupeArtifacts = (artifacts: ArtifactReference[]): ArtifactReference[] => {
  const map = new Map<string, ArtifactReference>();
  artifacts.forEach((artifact) => {
    const source = normalizeArtifactValue(artifact.source);
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

const resolveHostPath = (telegramUserId: number, source: string): string | null => {
  if (source.startsWith('file://')) {
    return resolveHostPath(telegramUserId, source.slice('file://'.length));
  }

  if (looksLikeContainerPath(source)) {
    return resolveContainerPathForUser(telegramUserId, source);
  }

  if (source.startsWith('./')) {
    const dirs = getUserContainerDirs(telegramUserId);
    const workspacePath = path.join(dirs.workspaceDir, source.slice(2));
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
    return path.join(dirs.dataDir, source.slice(2));
  }

  if (!path.isAbsolute(source) && !source.startsWith('..')) {
    const dirs = getUserContainerDirs(telegramUserId);
    const workspacePath = path.join(dirs.workspaceDir, source);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
  }

  if (path.isAbsolute(source)) {
    return resolveContainerPathForUser(telegramUserId, source);
  }

  return null;
};

const previewTextFile = async (ctx: Context, filePath: string): Promise<void> => {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_TEXT_PREVIEW_BYTES) return;

  const raw = await fs.promises.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).slice(0, 80);
  const preview = lines.join('\n').slice(0, 3200);
  if (!preview.trim()) return;

  const name = path.basename(filePath);
  const chunks = chunkText(`File preview: ${name}\n\n${preview}`);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
};

const sendRemoteArtifact = async (
  ctx: Context,
  source: string,
  asVoice: boolean
): Promise<boolean> => {
  if (isImagePath(source)) {
    await ctx.replyWithPhoto(source).catch(async () => {
      await ctx.reply(source);
    });
    return true;
  }

  if (isVideoPath(source)) {
    await ctx.replyWithVideo(source).catch(async () => {
      await ctx.reply(source);
    });
    return true;
  }

  if (isAudioPath(source)) {
    if (asVoice) {
      await ctx.replyWithVoice(source).catch(async () => {
        await ctx.replyWithAudio(source).catch(async () => {
          await ctx.reply(source);
        });
      });
    } else {
      await ctx.replyWithAudio(source).catch(async () => {
        await ctx.reply(source);
      });
    }
    return true;
  }

  await ctx.reply(source);
  return true;
};

const sendLocalArtifact = async (
  ctx: Context,
  hostPath: string,
  asVoice: boolean
): Promise<boolean> => {
  if (isImagePath(hostPath)) {
    await ctx.replyWithPhoto(new InputFile(hostPath));
    return true;
  }

  if (isVideoPath(hostPath)) {
    await ctx.replyWithVideo(new InputFile(hostPath));
    return true;
  }

  if (isAudioPath(hostPath)) {
    if (asVoice) {
      const preparedVoice = await prepareVoiceFile(hostPath);
      if (preparedVoice) {
        try {
          await ctx.replyWithVoice(preparedVoice.file);
          return true;
        } catch {
          await ctx.replyWithAudio(new InputFile(hostPath));
          return true;
        } finally {
          await preparedVoice.cleanup().catch(() => undefined);
        }
      }
    }
    await ctx.replyWithAudio(new InputFile(hostPath));
    return true;
  }

  await ctx.replyWithDocument(new InputFile(hostPath), {
    caption: `File: ${path.basename(hostPath)}`
  });
  if (isTextPath(hostPath)) {
    await previewTextFile(ctx, hostPath).catch(() => undefined);
  }
  return true;
};

const sendArtifact = async (
  ctx: Context,
  user: TelegramUser,
  artifact: ArtifactReference,
  options?: { asVoice?: boolean }
): Promise<boolean> => {
  const source = artifact.source;
  if (!source) return false;

  const asVoice = options?.asVoice === true;
  if (isUrl(source)) {
    return sendRemoteArtifact(ctx, source, asVoice);
  }

  const hostPath = resolveHostPath(user.telegram_user_id, source);
  if (!hostPath) return false;
  if (!fs.existsSync(hostPath)) return false;
  return sendLocalArtifact(ctx, hostPath, asVoice);
};

export const deliverOpenClawReply = async (
  ctx: Context,
  user: TelegramUser,
  reply: OpenClawChatReply
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

    if (parsed.text) {
      const textChunks = chunkText(parsed.text);
      for (const chunk of textChunks) {
        await sendTextReply(ctx, chunk);
        delivered = true;
      }
    }

    for (const artifact of artifacts.slice(0, MAX_ARTIFACTS_PER_REPLY)) {
      const ok = await sendArtifact(ctx, user, artifact, { asVoice: wantsVoice }).catch(() => false);
      if (!ok) continue;
      delivered = true;
      deliveredSources.add(normalizeArtifactValue(artifact.source));
    }

    if (artifacts.length > MAX_ARTIFACTS_PER_REPLY) {
      await ctx.reply(`There are ${artifacts.length - MAX_ARTIFACTS_PER_REPLY} more artifacts not shown.`);
      delivered = true;
    }
  }

  const trailingArtifacts = dedupeArtifacts(
    reply.artifacts.filter((artifact) => !deliveredSources.has(normalizeArtifactValue(artifact.source)))
  );

  for (const artifact of trailingArtifacts.slice(0, MAX_ARTIFACTS_PER_REPLY)) {
    const ok = await sendArtifact(ctx, user, artifact, { asVoice: FORCE_AUDIO_AS_VOICE }).catch(() => false);
    delivered = delivered || ok;
  }
  if (trailingArtifacts.length > MAX_ARTIFACTS_PER_REPLY) {
    await ctx.reply(`There are ${trailingArtifacts.length - MAX_ARTIFACTS_PER_REPLY} more artifacts not shown.`);
    delivered = true;
  }

  if (!delivered) {
    await ctx.reply('(empty response)');
  }
};
