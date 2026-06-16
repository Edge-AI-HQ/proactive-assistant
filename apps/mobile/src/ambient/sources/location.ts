/**
 * Location 源（RN 直替判定：expo-location 覆盖 @capacitor/geolocation +
 * Swift GeocodeService 的全部消费面——watch + 反地理编码）。信号形状与
 * web sources/location.ts 对齐（kind=device.location、payload 字段同名）。
 */
import * as Location from "expo-location";

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
    let place: string | undefined;
    try {
      const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
      const g = geo[0];
      if (g) place = [g.name, g.district, g.city].filter(Boolean).join(", ");
    } catch {
      /* geocode best-effort */
    }
    const summary = place ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    ctx.push({
      kind: SIGNAL_KINDS.location,
      title: "Location update",
      summary,
      occurred_at: new Date(pos.timestamp).toISOString(),
      payload: {
        latitude,
        longitude,
        accuracy,
        altitude,
        speed,
        heading,
        place,
      },
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
