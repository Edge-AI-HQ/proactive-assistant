const dangerousSvgBlockPattern = /<\s*(script|foreignObject|iframe|object|embed|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const dangerousSvgElementPattern = /<\/?(script|foreignObject|iframe|object|embed|style|link|meta)\b[^>]*>/gi;
const eventHandlerAttributePattern = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const processingInstructionPattern = /<\?[\s\S]*?\?>/g;
const urlAttributePattern = /\s+(href|xlink:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

function unquoteAttributeValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function codePointCharacter(value: number): string {
  try {
    return Number.isFinite(value) ? String.fromCodePoint(value) : "";
  } catch {
    return "";
  }
}

function decodeSvgAttributeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePointCharacter(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => codePointCharacter(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function safeSvgUrlAttribute(attribute: string, quotedValue: string): string {
  const value = decodeSvgAttributeEntities(unquoteAttributeValue(quotedValue))
    .trim()
    .replace(/[\u0000-\u001F\u007F\s]+/g, "");
  const normalized = value.toLowerCase();
  if (
    normalized.startsWith("javascript:")
    || normalized.startsWith("vbscript:")
    || normalized.startsWith("data:text/html")
    || normalized.startsWith("data:image/svg")
  ) {
    return "";
  }
  return ` ${attribute}=${quotedValue}`;
}

export function sanitizeTraceSvg(svg: string): string {
  const withoutProcessingInstructions = svg.trim().replace(processingInstructionPattern, "").trim();
  if (!/^<svg[\s>]/i.test(withoutProcessingInstructions)) return "";
  return withoutProcessingInstructions
    .replace(dangerousSvgBlockPattern, "")
    .replace(dangerousSvgElementPattern, "")
    .replace(eventHandlerAttributePattern, "")
    .replace(urlAttributePattern, (_match, attribute: string, quotedValue: string) => (
      safeSvgUrlAttribute(attribute, quotedValue)
    ))
    .trim();
}

export function traceSvgDataUrl(svg: string): string {
  const sanitized = sanitizeTraceSvg(svg);
  if (!sanitized) return "";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`;
}
