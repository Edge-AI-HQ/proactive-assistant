export function initialLoadRecoveryVisible<T>(error: string | null, value: T | null): boolean {
  return error !== null && value === null;
}

export function staleRefreshErrorMessage<T>(error: string | null, value: T | null, label: string): string | null {
  if (!error || value === null) return null;
  return `${label}刷新失败，当前仍显示上一次成功加载的数据：${error}`;
}
