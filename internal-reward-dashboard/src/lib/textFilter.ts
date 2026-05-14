export const REWARD_TEXT_FILTER_MAX_LENGTH = 120;

export function textFilterLengthError(
  value: string | undefined,
  label: string,
  maxLength = REWARD_TEXT_FILTER_MAX_LENGTH,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.length <= maxLength) return null;
  return `${label}不能超过 ${maxLength} 个字符。`;
}
