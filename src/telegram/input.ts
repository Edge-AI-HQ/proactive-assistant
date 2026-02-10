import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'grammy';
import { getUserContainerDirs } from '../docker/manager.js';
import type { OpenClawAttachment } from '../openclaw/client.js';
import { buildAgentFileBlockFromInbound } from './mediaUnderstanding.js';

const IMAGE_ATTACHMENT_MAX_BYTES = 5_000_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 90_000;

type DownloadedTelegramFile = {
  buffer: Buffer;
  filePath: string;
  fileName: string;
  contentType?: string;
};

type InboundMediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

interface StoredInboundFile {
  hostPath: string;
  containerPath: string;
}

export interface ParsedTelegramInput {
  text: string;
  attachments: OpenClawAttachment[];
}

const inferFileName = (filePath: string, fallback: string): string => {
  const name = filePath.split('/').at(-1);
  if (typeof name === 'string' && name.trim()) return name;
  return fallback;
};

const sanitizeFileName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : `file-${Date.now()}`;
};

const ensureInboundMediaPath = async (
  telegramUserId: number,
  fileName: string,
  buffer: Buffer
): Promise<StoredInboundFile> => {
  const dirs = getUserContainerDirs(telegramUserId);
  const inboundDir = path.join(dirs.tmpDir, 'telegram-inbound');
  await fs.promises.mkdir(inboundDir, { recursive: true });

  const safeFileName = sanitizeFileName(fileName);
  const uniqueFile = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeFileName}`;
  const hostPath = path.join(inboundDir, uniqueFile);
  await fs.promises.writeFile(hostPath, buffer);

  return {
    hostPath,
    containerPath: `/tmp/telegram-inbound/${uniqueFile}`
  };
};

const downloadTelegramFile = async (
  botToken: string,
  fileId: string,
  fallbackName: string
): Promise<DownloadedTelegramFile> => {
  const fileInfoResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    {
      signal: AbortSignal.timeout(30_000)
    }
  );

  const fileInfoJson: unknown = await fileInfoResponse.json().catch(() => null);
  const filePath =
    typeof fileInfoJson === 'object' &&
    fileInfoJson !== null &&
    'result' in fileInfoJson &&
    typeof (fileInfoJson as Record<string, unknown>).result === 'object' &&
    (fileInfoJson as { result?: { file_path?: string } }).result?.file_path
      ? (fileInfoJson as { result: { file_path: string } }).result.file_path
      : null;

  if (!fileInfoResponse.ok || !filePath) {
    throw new Error(`Failed to get Telegram file path for ${fileId}`);
  }

  const fileResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)
  });
  if (!fileResponse.ok) {
    throw new Error(`Failed to download Telegram file ${filePath}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const downloaded: DownloadedTelegramFile = {
    buffer,
    filePath,
    fileName: inferFileName(filePath, fallbackName)
  };
  const contentType = fileResponse.headers.get('content-type');
  if (typeof contentType === 'string' && contentType) {
    downloaded.contentType = contentType;
  }
  return downloaded;
};

const toImageAttachment = (file: DownloadedTelegramFile, mimeType?: string): OpenClawAttachment => {
  return {
    type: 'image',
    mimeType: mimeType || file.contentType || 'image/jpeg',
    fileName: file.fileName,
    content: file.buffer.toString('base64')
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const pushForwardedMediaText = (lines: string[], kind: InboundMediaKind, containerPath: string): void => {
  lines.push(`<media:${kind}>`);
  lines.push(`MEDIA: ${containerPath}`);
};

export const parseTelegramInput = async (
  ctx: Context,
  botToken: string,
  telegramUserId: number
): Promise<ParsedTelegramInput | null> => {
  const message = ctx.message;
  if (!message || !isRecord(message)) return null;

  const attachments: OpenClawAttachment[] = [];
  const mediaHints: string[] = [];

  const baseText =
    (typeof message.text === 'string'
      ? message.text
      : typeof message.caption === 'string'
        ? message.caption
        : '').trim();

  const registerFile = async (
    file: DownloadedTelegramFile,
    kind: InboundMediaKind,
    opts?: {
      imageMimeType?: string;
      includeImageAttachment?: boolean;
      includeFileBlock?: boolean;
      mimeType?: string;
    }
  ): Promise<void> => {
    const stored = await ensureInboundMediaPath(telegramUserId, file.fileName, file.buffer);
    pushForwardedMediaText(mediaHints, kind, stored.containerPath);

    if (opts?.includeImageAttachment) {
      if (file.buffer.length <= IMAGE_ATTACHMENT_MAX_BYTES) {
        attachments.push(toImageAttachment(file, opts.imageMimeType));
      }
    }

    if (opts?.includeFileBlock) {
      const fileBlockInput: { hostPath: string; fileName: string; mimeType?: string } = {
        hostPath: stored.hostPath,
        fileName: file.fileName
      };
      const resolvedMimeType = opts.mimeType || file.contentType;
      if (resolvedMimeType) {
        fileBlockInput.mimeType = resolvedMimeType;
      }
      const fileBlock = await buildAgentFileBlockFromInbound(fileBlockInput);
      if (fileBlock) {
        mediaHints.push(fileBlock);
      }
    }
  };

  const photos = Array.isArray(message.photo) ? message.photo : [];
  if (photos.length > 0) {
    const largest = photos[photos.length - 1];
    if (largest?.file_id) {
      const photo = await downloadTelegramFile(botToken, largest.file_id, `photo-${Date.now()}.jpg`);
      await registerFile(photo, 'image', {
        mimeType: 'image/jpeg',
        imageMimeType: 'image/jpeg',
        includeImageAttachment: true
      });
    }
  }

  const sticker = isRecord(message.sticker) ? message.sticker : null;
  if (sticker && typeof sticker.file_id === 'string') {
    const stickerFile = await downloadTelegramFile(botToken, sticker.file_id, `sticker-${Date.now()}.webp`);
    await registerFile(stickerFile, 'sticker', {
      mimeType: 'image/webp'
    });
  }

  const document = isRecord(message.document) ? message.document : null;
  if (document && typeof document.file_id === 'string') {
    const mimeType = typeof document.mime_type === 'string' ? document.mime_type : undefined;
    const fileName =
      typeof document.file_name === 'string' && document.file_name.trim()
        ? document.file_name
        : `document-${Date.now()}`;
    const downloaded = await downloadTelegramFile(botToken, document.file_id, fileName);
    const isImageDocument = Boolean(mimeType?.startsWith('image/'));
    const registerOptions: {
      imageMimeType?: string;
      includeImageAttachment?: boolean;
      includeFileBlock?: boolean;
      mimeType?: string;
    } = {
      includeImageAttachment: isImageDocument,
      includeFileBlock: !isImageDocument
    };
    if (mimeType) {
      registerOptions.mimeType = mimeType;
    }
    if (mimeType) {
      registerOptions.imageMimeType = mimeType;
    }
    await registerFile(downloaded, isImageDocument ? 'image' : 'document', registerOptions);
  }

  const video = isRecord(message.video) ? message.video : null;
  if (video && typeof video.file_id === 'string') {
    const downloaded = await downloadTelegramFile(botToken, video.file_id, `video-${Date.now()}.mp4`);
    const videoMimeType = typeof video.mime_type === 'string' ? video.mime_type : '';
    await registerFile(downloaded, 'video', videoMimeType ? { mimeType: videoMimeType } : undefined);
  }

  const animation = isRecord(message.animation) ? message.animation : null;
  if (animation && typeof animation.file_id === 'string') {
    const downloaded = await downloadTelegramFile(botToken, animation.file_id, `animation-${Date.now()}.gif`);
    await registerFile(downloaded, 'video', {
      mimeType: 'image/gif'
    });
  }

  const videoNote = isRecord(message.video_note) ? message.video_note : null;
  if (videoNote && typeof videoNote.file_id === 'string') {
    const downloaded = await downloadTelegramFile(botToken, videoNote.file_id, `video-note-${Date.now()}.mp4`);
    await registerFile(downloaded, 'video', {
      mimeType: 'video/mp4'
    });
  }

  const voice = isRecord(message.voice) ? message.voice : null;
  if (voice && typeof voice.file_id === 'string') {
    const downloaded = await downloadTelegramFile(botToken, voice.file_id, `voice-${Date.now()}.ogg`);
    const voiceMimeType = typeof voice.mime_type === 'string' ? voice.mime_type : 'audio/ogg';
    await registerFile(downloaded, 'audio', {
      mimeType: voiceMimeType
    });
  }

  const audio = isRecord(message.audio) ? message.audio : null;
  if (audio && typeof audio.file_id === 'string') {
    const downloaded = await downloadTelegramFile(botToken, audio.file_id, `audio-${Date.now()}.ogg`);
    const audioMimeType = typeof audio.mime_type === 'string' ? audio.mime_type : '';
    await registerFile(downloaded, 'audio', audioMimeType ? { mimeType: audioMimeType } : undefined);
  }

  const text = [baseText, ...mediaHints].filter(Boolean).join('\n').trim();
  if (!text && attachments.length === 0) {
    return null;
  }

  return {
    text: text || '请处理这个附件。',
    attachments
  };
};
