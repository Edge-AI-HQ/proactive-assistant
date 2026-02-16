import fs from 'node:fs';
import path from 'node:path';
import { getUserContainerDirs, resolveContainerPathForUser } from '../docker/manager.js';
import { looksLikeContainerPath } from '../openclaw/artifactReferences.js';

export const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

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

export const isImagePath = (value: string): boolean =>
  /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(normalizePathForExtCheck(value));

export const isAudioPath = (value: string): boolean =>
  /\.(mp3|wav|ogg|opus|m4a|aac)$/i.test(normalizePathForExtCheck(value));

export const isVideoPath = (value: string): boolean =>
  /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(normalizePathForExtCheck(value));

export const isVoiceCompatibleAudio = (value: string): boolean =>
  /\.(ogg|opus)$/i.test(normalizePathForExtCheck(value));

export const isTextPath = (value: string): boolean =>
  /\.(txt|md|json|csv|ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|yaml|yml|toml|xml|html|css|log|sql)$/i.test(
    normalizePathForExtCheck(value)
  );

export const resolveHostPath = (telegramUserId: number, source: string): string | null => {
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
