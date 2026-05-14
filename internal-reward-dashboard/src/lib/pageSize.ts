export function normalizePageSize(value: number, allowed: number[], fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return allowed.includes(value) ? value : fallback;
}
