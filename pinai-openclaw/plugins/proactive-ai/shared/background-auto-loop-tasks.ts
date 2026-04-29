const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

export function isBackgroundAutoLoopTasksEnabled(): boolean {
  const raw = process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}
