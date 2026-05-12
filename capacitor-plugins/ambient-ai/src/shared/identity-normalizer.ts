/**
 * Identity (email / phone / handle / url) normalizer used by TS adapters
 * that aggregate over user-entered identifier fields. TS port of the now
 * deleted Swift `IdentityNormalizer`.
 *
 * Normalization rules are intentionally conservative — we lower-case emails
 * and URLs, strip non-digit characters from phones (preserving leading `+`),
 * and only special-case the US 10/11-digit pattern. Anything we cannot
 * confidently classify is returned as `unknown` with the trimmed input.
 */
export type IdentityKind = 'email' | 'phone' | 'handle' | 'url' | 'unknown';

export interface NormalizedIdentity {
  kind: IdentityKind;
  raw: string;
  normalized: string;
}

export function normalizeIdentity(raw: string, kind?: IdentityKind): NormalizedIdentity {
  const trimmed = raw.trim();
  const detected = kind ?? detectKind(trimmed);
  switch (detected) {
    case 'email':
      return { kind: 'email', raw, normalized: trimmed.toLowerCase() };
    case 'phone':
      return { kind: 'phone', raw, normalized: normalizePhone(trimmed) };
    case 'handle': {
      let s = trimmed.toLowerCase();
      if (s.startsWith('@')) s = s.slice(1);
      return { kind: 'handle', raw, normalized: s };
    }
    case 'url':
      return { kind: 'url', raw, normalized: trimmed.toLowerCase() };
    case 'unknown':
      return { kind: 'unknown', raw, normalized: trimmed };
  }
}

function detectKind(s: string): IdentityKind {
  if (s.includes('@') && s.includes('.') && !s.startsWith('@')) return 'email';
  const lower = s.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'url';
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 7) return 'phone';
  if (s.startsWith('@')) return 'handle';
  return 'unknown';
}

function normalizePhone(raw: string): string {
  let hasPlus = false;
  let digits = '';
  for (const ch of raw) {
    if (ch === '+' && digits.length === 0) hasPlus = true;
    else if (ch >= '0' && ch <= '9') digits += ch;
  }
  if (digits.length === 0) return raw;
  if (!hasPlus && digits.length === 11 && digits.startsWith('1')) {
    return '+' + digits;
  }
  return (hasPlus ? '+' : '') + digits;
}
