const AMBIENT_ENABLED_STORAGE_KEY = "pin.ambient.enabled";

export function getPersistedAmbientEnabled(): boolean {
  try {
    return localStorage.getItem(AMBIENT_ENABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPersistedAmbientEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(AMBIENT_ENABLED_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(AMBIENT_ENABLED_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}
