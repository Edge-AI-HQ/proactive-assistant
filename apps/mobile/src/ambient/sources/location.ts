/**
 * Location 源（RN 直替判定：expo-location 覆盖 @capacitor/geolocation +
 * Swift GeocodeService 的全部消费面——watch + 反地理编码）。信号形状与
 * web sources/location.ts 对齐（kind=device.location、payload 字段同名）。
 */
import * as Location from "expo-location";

import { AmbientVisit, type PlaceInfo } from "../../../modules/ambient-visit";
import { buildLocationSignal } from "./geocode";
import {
  SIGNAL_KINDS,
  type AmbientSource,
  type AmbientSourceStartOptions,
  type SourceContext,
} from "../types";

const MIN_INTERVAL_MS = 5 * 60 * 1000; // 同 web：5 分钟节流
const MIN_DISTANCE_M = 250;

export function createLocationSource(ctx: SourceContext): AmbientSource {
  let sub: Location.LocationSubscription | null = null;
  let lastPushed = 0;

  async function handle(pos: Location.LocationObject) {
    if (Date.now() - lastPushed < MIN_INTERVAL_MS) return;
    lastPushed = Date.now();
    const { latitude, longitude, accuracy, altitude, speed, heading } = pos.coords;
    // 反地理编码走原生 GeocodeService（CLGeocoder + MapKit POI 带距离），对齐 web 的
    // AmbientAi.geocoder.reverseGeocode。expo-location 只给扁平地址、拿不到 POI 距离，
    // 不足以复刻 nearby_poi 判定，所以改用原生模块（能力与 dev 一致，不阉割）。
    let place: PlaceInfo | null = null;
    try {
      place = await AmbientVisit.reverseGeocode(latitude, longitude);
    } catch {
      /* geocode best-effort；拿不到就退回坐标（见 buildLocationSignal） */
    }
    // display_place / place / candidates / place_resolution 组装与 web 一致；共享 normalize
    // 从 display_place.label 生成 "Location: <地名>."，live 卡据此渲染 "Near <地名>"。
    const { summary, payload } = buildLocationSignal(
      { latitude, longitude, accuracy, altitude, speed, heading },
      place,
    );
    ctx.push({
      kind: SIGNAL_KINDS.location,
      title: "Location update",
      summary,
      occurred_at: new Date(pos.timestamp).toISOString(),
      payload,
    });
    ctx.onEvent("location", summary);
  }

  return {
    key: "location",
    label: "Location",
    isStarted: () => sub !== null,
    async start(options?: AmbientSourceStartOptions) {
      if (sub) return;
      const { status } =
        options?.interactivePermissions === false
          ? await Location.getForegroundPermissionsAsync()
          : await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") throw new Error("location permission denied");
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: MIN_INTERVAL_MS,
          distanceInterval: MIN_DISTANCE_M,
        },
        (pos) => void handle(pos),
      );
    },
    async stop() {
      sub?.remove();
      sub = null;
    },
  };
}
