/**
 * Ambient 运行时（RN）：source 生命周期 + ingest loop。开关 = 本地
 * opt-in（AsyncStorage，per-device 授权语义与 Capacitor 版一致：本机没
 * 显式打开就绝不采集）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { pushSignal, startIngestLoop, stopIngestLoop } from "./ingest";
import { createActivitySource } from "./sources/activity";
import { createAudioRouteSource } from "./sources/audio-route";
import { createCalendarSource } from "./sources/calendar";
import { createDeviceStateSource } from "./sources/device-state";
import { createFocusSource } from "./sources/focus";
import { createHealthSource } from "./sources/health";
import { createLocationSource } from "./sources/location";
import { createSoundClassifierSource } from "./sources/sound-classifier";
import { createVisitSource } from "./sources/visit";
import type { AmbientSource, SourceContext } from "./types";

const ENABLED_KEY = "pinai:ambient-enabled";

const ctx: SourceContext = {
  push: pushSignal,
  onEvent: (key, summary) => console.log(`[ambient:${key}] ${summary}`),
};

const sources: AmbientSource[] = [
  createLocationSource(ctx),
  createDeviceStateSource(ctx),
  createCalendarSource(ctx),
  createHealthSource(ctx),
  createVisitSource(ctx),
  createActivitySource(ctx),
  createSoundClassifierSource(ctx),
  createFocusSource(ctx),
  createAudioRouteSource(ctx),
];

let running = false;

export async function isAmbientEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
}

export async function startAmbient(userId: string): Promise<string[]> {
  await AsyncStorage.setItem(ENABLED_KEY, "1");
  startIngestLoop(userId);
  const started: string[] = [];
  for (const s of sources) {
    try {
      await s.start();
      started.push(s.key);
    } catch (err) {
      // 单源权限被拒不影响其他源（与 web startAmbientUpload 同语义）。
      console.warn(`[ambient] ${s.key} failed to start:`, err);
    }
  }
  running = true;
  return started;
}

export async function stopAmbient(): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, "0");
  for (const s of sources) {
    await s.stop().catch(() => {});
  }
  stopIngestLoop();
  running = false;
}

export function ambientRunning(): boolean {
  return running;
}

/** 登录后恢复：本机此前显式开过才自动续采。 */
export async function resumeAmbientIfEnabled(userId: string): Promise<void> {
  if (await isAmbientEnabled()) {
    await startAmbient(userId);
  }
}
