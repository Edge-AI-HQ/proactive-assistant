import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getUserContainerDirs } from '../docker/manager.js';
import type { OpenClawAttachment } from '../openclaw/chatSessionService.js';

const IMAGE_ATTACHMENT_MAX_BYTES = 5_000_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 90_000;

export type DownloadedTelegramFile = {
  buffer: Buffer;
  filePath: string;
  fileName: string;
  contentType?: string;
};

interface StoredInboundFile {
  hostPath: string;
  containerPath: string;
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

export const ensureInboundMediaPath = async (
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

export const downloadTelegramFile = async (
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

export const toImageAttachment = (file: DownloadedTelegramFile, mimeType?: string): OpenClawAttachment => {
  return {
    type: 'image',
    mimeType: mimeType || file.contentType || 'image/jpeg',
    fileName: file.fileName,
    content: file.buffer.toString('base64')
  };
};

export const shouldIncludeImageAttachment = (file: DownloadedTelegramFile): boolean => {
  return file.buffer.length <= IMAGE_ATTACHMENT_MAX_BYTES;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};
