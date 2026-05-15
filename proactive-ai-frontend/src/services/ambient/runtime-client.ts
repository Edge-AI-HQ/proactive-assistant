import type { AmbientRuntime } from "./index";

export async function loadAmbientRuntime(): Promise<AmbientRuntime> {
  const { getAmbientRuntime } = await import("./index");
  return getAmbientRuntime();
}
