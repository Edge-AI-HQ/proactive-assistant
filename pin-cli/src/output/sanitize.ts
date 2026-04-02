const isDangerousUnicode = (code: number): boolean =>
  // Zero-width: ZWSP, ZWNJ, ZWJ
  (code >= 0x200b && code <= 0x200d) ||
  // BOM / ZWNBSP
  code === 0xfeff ||
  // BiDi overrides: LRE, RLE, PDF, LRO, RLO
  (code >= 0x202a && code <= 0x202e) ||
  // Line/paragraph separators
  code === 0x2028 ||
  code === 0x2029 ||
  // BiDi isolates: LRI, RLI, FSI, PDI
  (code >= 0x2066 && code <= 0x2069);

export const rejectDangerousChars = (
  paramName: string,
  value: string,
): void => {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isDangerousUnicode(code)) {
      throw new SanitizeError(
        paramName,
        `contains dangerous Unicode character U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
};

export const validateSafePath = (paramName: string, path: string): void => {
  if (path.includes("..")) {
    throw new SanitizeError(paramName, "path traversal detected (..)");
  }
  if (/^[/\\]/.test(path) || /^[a-zA-Z]:/.test(path)) {
    throw new SanitizeError(paramName, "absolute paths not allowed");
  }
};

export class SanitizeError extends Error {
  readonly paramName: string;

  constructor(paramName: string, reason: string) {
    super(`Parameter '${paramName}': ${reason}`);
    this.paramName = paramName;
  }
}

export const sanitizeForTerminal = (text: string): string => {
  const ansiEscape = /\x1b\[[0-9;?>=!]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
  let result = text.replace(ansiEscape, "");

  let output = "";
  for (const ch of result) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x0a || code === 0x09) {
      output += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    if (isDangerousUnicode(code)) continue;
    output += ch;
  }

  return output;
};
