export async function isAmbientEnabled(): Promise<boolean> {
  return false;
}

export async function startAmbient(
  _userId: string,
  _opts: { interactivePermissions?: boolean } = {},
): Promise<string[]> {
  return [];
}

export async function stopAmbient(): Promise<void> {
  // Ambient capture is native-only.
}

export function ambientRunning(): boolean {
  return false;
}

export async function resumeAmbientIfEnabled(_userId: string): Promise<void> {
  // Ambient capture is native-only.
}
