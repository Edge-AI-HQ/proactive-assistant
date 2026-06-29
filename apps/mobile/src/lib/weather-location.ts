/**
 * 天气用的「设备当前位置」（GPS）—— 复用 ambient 的 expo-location 基建（同一个 iOS 前台定位
 * 权限：在 ambient 的 location 源/设置里授予后，ambient 与天气两处共用，不另弹窗）。
 *
 * 仅在前台定位权限「已授予」时取 GPS（use-if-granted）：未授予 → 返回 null，core 的
 * fetchWeather 自动回退 IP 定位，所以即使没开 ambient 也有城市级天气；开了 ambient（授予定位）
 * 后天气自动升级到 GPS 精度。城市经 reverseGeocode 取（与 ambient sources/location.ts 同法）。
 */
import * as Location from "expo-location";
import type { WeatherCoords } from "@pin-ai/core";

export async function getDeviceWeatherCoords(): Promise<WeatherCoords | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted") return null; // 未授权 → null → fetchWeather 走 IP 兜底
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const { latitude, longitude } = pos.coords;
    let city: string | undefined;
    try {
      const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
      city = geo[0]?.city ?? undefined;
    } catch {
      /* 反向地理编码 best-effort：失败就只用坐标、省略城市段 */
    }
    return { lat: latitude, lon: longitude, city };
  } catch {
    return null; // 取位失败也回退 IP
  }
}
