export function scoreSaveErrorMessage(saved: boolean, err: unknown): string {
  const message = err instanceof Error ? err.message : "评分保存失败。";
  return saved ? `评分已保存，但页面刷新失败：${message}` : `评分保存失败：${message}`;
}

export function casebookDeleteErrorMessage(deleted: boolean, err: unknown): string {
  const message = err instanceof Error ? err.message : "移除失败。";
  return deleted ? `样本已移除，但页面刷新失败：${message}` : `移除失败：${message}`;
}
