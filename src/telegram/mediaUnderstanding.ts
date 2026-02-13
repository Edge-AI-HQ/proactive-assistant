import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_EXTRACTED_CHARS = 120_000;
const PDF_EXTRACT_TIMEOUT_MS = 20_000;
const PDF_EXTRACT_MAX_BUFFER = 8_000_000;

const TEXT_FILE_EXT_RE =
  /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|yaml|yml|toml|xml|html|css|log|sql|sh|bash|zsh|ini|cfg)$/i;

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'application/x-javascript',
  'application/sql'
]);

interface InboundFileForAgent {
  hostPath: string;
  fileName: string;
  mimeType?: string;
}

const normalizeMimeType = (value: string | undefined): string => {
  if (!value) return '';
  return value.split(';', 1)[0]?.trim().toLowerCase() || '';
};

const escapeXmlAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeFileBlockContent = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const truncateExtractedText = (value: string): string => {
  const normalized = value.replaceAll('\u0000', '').trim();
  if (normalized.length <= MAX_EXTRACTED_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EXTRACTED_CHARS)}\n[truncated]`;
};

const isPdfFile = (fileName: string, mimeType: string): boolean => {
  if (mimeType === 'application/pdf') return true;
  return /\.pdf$/i.test(fileName);
};

const isTextLikeFile = (fileName: string, mimeType: string): boolean => {
  if (mimeType.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_FILE_EXT_RE.test(fileName);
};

const extractTextFromPdf = async (filePath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-enc', 'UTF-8', '-q', filePath, '-'],
      {
        timeout: PDF_EXTRACT_TIMEOUT_MS,
        maxBuffer: PDF_EXTRACT_MAX_BUFFER
      }
    );
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null;
  }
};

const extractTextFromFile = async (filePath: string): Promise<string | null> => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TEXT_FILE_BYTES) {
      return null;
    }
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
};

const fallbackMimeType = (fileName: string, current: string): string => {
  if (current) return current;
  if (/\.pdf$/i.test(fileName)) return 'application/pdf';
  if (TEXT_FILE_EXT_RE.test(fileName)) return 'text/plain';
  return 'application/octet-stream';
};

const buildFileBlock = (fileName: string, mimeType: string, text: string): string => {
  const safeName = fileName.replace(/[\r\n\t]+/g, ' ').trim() || path.basename(fileName);
  return `<file name="${escapeXmlAttr(safeName)}" mime="${escapeXmlAttr(mimeType)}">\n${escapeFileBlockContent(
    text
  )}\n</file>`;
};

export const buildAgentFileBlockFromInbound = async (
  file: InboundFileForAgent
): Promise<string | null> => {
  const normalizedMime = normalizeMimeType(file.mimeType);
  const resolvedMime = fallbackMimeType(file.fileName, normalizedMime);

  let extracted: string | null = null;
  if (isPdfFile(file.fileName, resolvedMime)) {
    extracted = await extractTextFromPdf(file.hostPath);
  } else if (isTextLikeFile(file.fileName, resolvedMime)) {
    extracted = await extractTextFromFile(file.hostPath);
  } else {
    return null;
  }

  const blockText = truncateExtractedText(extracted || '') || '[No extractable text]';
  return buildFileBlock(file.fileName, resolvedMime, blockText);
};
