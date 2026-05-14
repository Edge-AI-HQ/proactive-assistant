export function finiteCount(value: number | null | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function formatCount(value: number | null | undefined, fallback = 0): string {
  return finiteCount(value, fallback).toLocaleString();
}

export function totalPagesFor(total: number | null | undefined, pageSize: number): number {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 1;
  return Math.max(1, Math.ceil(finiteCount(total) / safePageSize));
}

export function pageWithinTotal(page: number, total: number | null | undefined, pageSize: number): number {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  return Math.min(safePage, totalPagesFor(total, pageSize));
}

export function totalPagesForOffsetLimit(
  total: number | null | undefined,
  pageSize: number,
  maxOffset: number,
): number {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 1;
  if (!Number.isInteger(maxOffset) || maxOffset < 0) return totalPagesFor(total, safePageSize);
  const maxReachablePage = Math.floor(maxOffset / safePageSize) + 1;
  return Math.min(totalPagesFor(total, safePageSize), maxReachablePage);
}

export function pageWithinOffsetLimit(
  page: number,
  total: number | null | undefined,
  pageSize: number,
  maxOffset: number,
): number {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  return Math.min(safePage, totalPagesForOffsetLimit(total, pageSize, maxOffset));
}
