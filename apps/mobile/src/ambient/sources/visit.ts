/**
 * Visit 源（Swift 保留件：CLVisitMonitor 经 ambient-visit Expo module）。
 * 双通道：visit 事件即时推 + durable 队列周期 drain/ack（后台 visit 杀
 * app 不丢——与 Capacitor 版同语义）。place 由 JS 侧 expo-location 反
 * 编码补全（Swift 侧不再内置 Geocode）。需要 Always 位置权限。
 */
import * as Location from "expo-location";

import { AmbientVisit, type VisitEvent } from "../../../modules/ambient-visit";
import {
  SIGNAL_KINDS,
  type AmbientSource,
  type AmbientSourceStartOptions,
  type SourceContext,
} from "../types";

const DRAIN_INTERVAL_MS = 5 * 60 * 1000;

export function createVisitSource(ctx: SourceContext): AmbientSource {
  let started = false;
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  async function pushVisit(event: VisitEvent): Promise<void> {
    const isArrival = event.departureAt === null;
    // place 由原生到访时 GeocodeService（CLGeocoder + MapKit POI）反编码补全 = event.place。
    // 万一 drain 早于原生反编码完成（placeStatus 尚 pending），用同一原生服务补一次（有 LRU 缓存）。
    let place = event.place ?? null;
    if (!place) {
      try {
        place = await AmbientVisit.reverseGeocode(event.latitude, event.longitude);
      } catch {
        /* best-effort */
      }
    }
    // 与 web visit 源一致：label ?? place_name ?? address。共享 normalize 读 place.label →
    // "Arrived near <地名>." → live 卡渲染 "Near <地名>"。
    const placeLabel = place?.label ?? place?.place_name ?? place?.address;
    const summary = `${isArrival ? "Arrived" : "Left"}${placeLabel ? ` · ${placeLabel}` : ""}`;
    const ts = isArrival ? event.arrivalAt : (event.departureAt ?? event.arrivalAt);
    ctx.push({
      kind: SIGNAL_KINDS.visit,
      title: isArrival ? "Place arrival" : "Place departure",
      summary,
      occurred_at: new Date(ts).toISOString(),
      dedupe_key: event.id,
      payload: {
        arrival_at: event.arrivalAt,
        departure_at: event.departureAt,
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        // 富 PlaceInfo（含 label / candidates / area），normalize 读 .label 渲染 "Near <地名>"。
        place: place ?? undefined,
      },
    });
    ctx.onEvent("visit", summary);
  }

  async function drain(): Promise<void> {
    const pending = await AmbientVisit.drainPendingVisits(50);
    if (pending.length === 0) return;
    for (const p of pending) {
      await pushVisit(p.payload);
    }
    await AmbientVisit.ackPendingVisits(pending.map((p) => p.id));
  }

  return {
    key: "visit",
    label: "Visits",
    isStarted: () => started,
    async start(options?: AmbientSourceStartOptions) {
      if (started) return;
      // CLVisit 要求 Always 权限（后台到访检测）。
      const { status } =
        options?.interactivePermissions === false
          ? await Location.getBackgroundPermissionsAsync()
          : await Location.requestBackgroundPermissionsAsync();
      if (status !== "granted") throw new Error("always location permission denied");
      await AmbientVisit.startMonitoring();
      await drain(); // 启动先清积压（上次后台攒下的）
      drainTimer = setInterval(() => void drain(), DRAIN_INTERVAL_MS);
      started = true;
    },
    async stop() {
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
      await AmbientVisit.stopMonitoring();
      started = false;
    },
    refresh: drain,
  };
}
