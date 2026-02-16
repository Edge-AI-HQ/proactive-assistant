import type { Context } from 'grammy';
import { config } from '../config.js';
import type { OpenClawAttachment } from '../openclaw/chatSessionService.js';
import { buildAgentFileBlockFromInbound } from './mediaUnderstanding.js';
import {
  type DownloadedTelegramFile,
  downloadTelegramFile,
  ensureInboundMediaPath,
  isRecord,
  shouldIncludeImageAttachment,
  toImageAttachment
} from './inputFileHelpers.js';

type InboundMediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export interface ParsedTelegramInput {
  text: string;
  attachments: OpenClawAttachment[];
}

const pushForwardedMediaText = (lines: string[], kind: InboundMediaKind, containerPath: string): void => {
  lines.push(`<media:${kind}>`);
  lines.push(`MEDIA: ${containerPath}`);
};

const buildFileBlockForInbound = async (
  stored: { hostPath: string },
  file: DownloadedTelegramFile,
  mimeType?: string
): Promise<string | null> => {
  const fileBlockInput: { hostPath: string; fileName: string; mimeType?: string } = {
    hostPath: stored.hostPath,
    fileName: file.fileName
  };
  if (mimeType) {
    fileBlockInput.mimeType = mimeType;
  }
  return buildAgentFileBlockFromInbound(fileBlockInput);
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
    const resolvedMimeType = opts?.mimeType || file.contentType;

    if (config.container.runtime === 'fly') {
      if (opts?.includeFileBlock) {
        const stored = await ensureInboundMediaPath(telegramUserId, file.fileName, file.buffer);
        const fileBlock = await buildFileBlockForInbound(stored, file, resolvedMimeType);
        if (fileBlock) {
          mediaHints.push(fileBlock);
          return;
        }
      }

      const mimeType = resolvedMimeType || 'application/octet-stream';
      const normalizedMimeType = mimeType.toLowerCase();
      const type: OpenClawAttachment['type'] =
        opts?.includeImageAttachment || kind === 'image' || kind === 'sticker' || normalizedMimeType.startsWith('image/')
          ? 'image'
          : kind === 'audio' || normalizedMimeType.startsWith('audio/')
            ? 'audio'
            : kind === 'video' || normalizedMimeType.startsWith('video/')
              ? 'video'
              : 'file';
      attachments.push({
        type,
        mimeType,
        fileName: file.fileName,
        content: file.buffer.toString('base64')
      });
      return;
    }

    const stored = await ensureInboundMediaPath(telegramUserId, file.fileName, file.buffer);
    pushForwardedMediaText(mediaHints, kind, stored.containerPath);

    if (opts?.includeImageAttachment && shouldIncludeImageAttachment(file)) {
      attachments.push(toImageAttachment(file, opts.imageMimeType));
    }

    if (opts?.includeFileBlock) {
      const fileBlock = await buildFileBlockForInbound(stored, file, resolvedMimeType);
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
