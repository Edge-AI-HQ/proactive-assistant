/**
 * Ambient 运行时（RN）：source 生命周期 + ingest loop。开关 = 本地
 * opt-in（AsyncStorage，per-device 授权语义与 Capacitor 版一致：本机没
 * 显式打开就绝不采集）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AmbientLifecycleController, type AmbientStartSession } from "@pin-ai/core";

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
const SOURCE_START_TIMEOUT_MS = 8_000;

const ctx: SourceContext = {
  push: pushSignal,
  onEvent: (key, summary) => console.log(`[ambient:${key}] ${summary}`),
};

const lifecycle = new AmbientLifecycleController();

const sources: AmbientSource[] = [
  createLocationSource(ctx),
  createDeviceStateSource(ctx),
  createSoundClassifierSource(ctx),
  createAudioRouteSource(ctx),
  createCalendarSource(ctx),
  createHealthSource(ctx),
  createVisitSource(ctx),
  createActivitySource(ctx),
  createFocusSource(ctx),
];

let startPromise: Promise<string[]> | null = null;
let startPromiseSession: AmbientStartSession | null = null;

interface StartAmbientOptions {
  interactivePermissions?: boolean;
}

export async function isAmbientEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
}

export async function startAmbient(
  userId: string,
  opts: StartAmbientOptions = {},
): Promise<string[]> {
  if (lifecycle.runningFor(userId)) return lifecycle.startedSourceKeys;
  if (startPromise && lifecycle.ownerUserId === userId) return startPromise;
  if (lifecycle.running || startPromise) await stopAmbient();
  const session = lifecycle.beginStart(userId, opts.interactivePermissions ?? true);
  startPromiseSession = session;
  startPromise = startAmbientSources(session).finally(() => {
    if (startPromiseSession?.id === session.id) {
      startPromise = null;
      startPromiseSession = null;
    }
  });
  return startPromise;
}

async function startAmbientSources(session: AmbientStartSession): Promise<string[]> {
  await AsyncStorage.setItem(ENABLED_KEY, "1");
  if (!lifecycle.isCurrentStart(session)) return [];
  startIngestLoop(session.userId);
  const started: string[] = [];
  for (const s of sources) {
    if (!lifecycle.isCurrentStart(session)) break;
    try {
      ctx.onEvent(s.key, "starting");
      const status = await startSourceForSession(session, s);
      if (status === "cancelled") break;
      started.push(s.key);
      ctx.onEvent(s.key, "started");
    } catch (err) {
      // 单源权限被拒不影响其他源（与 web startAmbientUpload 同语义）。
      console.warn(`[ambient] ${s.key} failed to start:`, err);
    }
  }
  const result = lifecycle.completeStart(session, started);
  if (result !== "started") {
    await AsyncStorage.setItem(ENABLED_KEY, "0");
    stopIngestLoop();
  }
  return result === "started" ? started : [];
}

export async function stopAmbient(): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, "0");
  lifecycle.stop();
  startPromise = null;
  startPromiseSession = null;
  for (const s of sources) {
    await s.stop().catch(() => {});
  }
  stopIngestLoop();
}

export function ambientRunning(): boolean {
  return lifecycle.running;
}

/** 登录后恢复：本机此前显式开过才自动续采。 */
export async function resumeAmbientIfEnabled(userId: string): Promise<void> {
  if (await isAmbientEnabled()) {
    await startAmbient(userId, { interactivePermissions: false });
  }
}

async function startSourceForSession(
  session: AmbientStartSession,
  source: AmbientSource,
): Promise<"started" | "cancelled"> {
  let settled = false;
  const startTask = source
    .start({
      interactivePermissions: lifecycle.interactivePermissions,
    })
    .finally(() => {
      settled = true;
    });
  try {
    await withTimeout(startTask, SOURCE_START_TIMEOUT_MS, source.key);
  } catch (err) {
    if (!settled) {
      void startTask.then(
        () => void source.stop().catch(() => {}),
        () => {},
      );
    }
    throw err;
  }
  if (!lifecycle.isCurrentStart(session)) {
    await source.stop().catch(() => {});
    return "cancelled";
  }
  return "started";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  key: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${key} start timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
