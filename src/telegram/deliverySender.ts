import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { InputFile, type Context } from 'grammy';
import { type ArtifactReference } from '../openclaw/artifacts.js';
import { renderTelegramHtmlFromMarkdown } from './format.js';
import { TELEGRAM_PARSE_ERROR_RE } from './constants.js';
import { chunkTelegramText } from './text.js';
import type { TelegramDeliveryUser } from './deliveryTypes.js';
import {
  isAudioPath,
  isImagePath,
  isTextPath,
  isUrl,
  isVideoPath,
  isVoiceCompatibleAudio,
  resolveHostPath
} from './deliveryPaths.js';

const MAX_TEXT_PREVIEW_BYTES = 200_000;
const VOICE_TRANSCODE_TIMEOUT_MS = 45_000;

interface PreparedVoiceFile {
  file: InputFile;
  cleanup: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

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

export const sendTextReply = async (ctx: Context, text: string): Promise<void> => {
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

const previewTextFile = async (ctx: Context, filePath: string): Promise<void> => {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_TEXT_PREVIEW_BYTES) return;

  const raw = await fs.promises.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).slice(0, 80);
  const preview = lines.join('\n').slice(0, 3200);
  if (!preview.trim()) return;

  const name = path.basename(filePath);
  const chunks = chunkTelegramText(`File preview: ${name}\n\n${preview}`);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
};

const sendRemoteArtifact = async (ctx: Context, source: string, asVoice: boolean): Promise<boolean> => {
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

const sendLocalArtifact = async (ctx: Context, hostPath: string, asVoice: boolean): Promise<boolean> => {
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

export const sendArtifact = async (
  ctx: Context,
  user: TelegramDeliveryUser,
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
