const normalizeInput = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const slugifyUnicode = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const stableHash = (value: string): string => {
  let hash = 2166136261;

  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash.toString(36);
};

export function makeTitleKey(title: string): string {
  const normalized = normalizeInput(title);
  const slug = slugifyUnicode(normalized);
  return slug.length > 0 ? slug : `untitled-${stableHash(normalized)}`;
}

export function makeIntentKey(goalBasket: string, title: string): string {
  const basket = slugifyUnicode(normalizeInput(goalBasket));
  return `${basket || "general"}:${makeTitleKey(title)}`;
}
