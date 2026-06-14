/**
 * 天气逻辑 + 数据获取。平台无关:IP geo 定位 + open-meteo 都走 universal fetch
 * (web / RN 通用),不碰 DOM / 平台存储。图标键(iconKey)交各端绑定。
 * state 的 useWeatherData 消费 fetchWeather(TQ 缓存替代原 web 端 sessionStorage)。
 */

export type WeatherIconKey =
  | "sun"
  | "cloud"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "lightning";

export interface WeatherSnapshot {
  temp: number;
  label: string;
  iconKey: WeatherIconKey;
  city?: string;
}

/** WMO weather code → 展示文案 + 语义图标键。各端把 iconKey 绑成自己的图标。 */
export function weatherMeta(code: number): { label: string; iconKey: WeatherIconKey } {
  if (code === 0) return { label: "Clear", iconKey: "sun" };
  if (code <= 3) return { label: "Cloudy", iconKey: "cloud" };
  if (code <= 48) return { label: "Foggy", iconKey: "fog" };
  if (code <= 57) return { label: "Drizzle", iconKey: "drizzle" };
  if (code <= 67) return { label: "Rainy", iconKey: "rain" };
  if (code <= 77) return { label: "Snowy", iconKey: "snow" };
  if (code <= 82) return { label: "Showers", iconKey: "rain" };
  if (code >= 95) return { label: "Stormy", iconKey: "lightning" };
  return { label: "Cloudy", iconKey: "cloud" };
}

interface GeoLookup {
  lat: number;
  lon: number;
  city?: string;
}

// Multi-source IP geolocation. All HTTPS — iOS App Transport Security blocks
// plain HTTP. Try each source in order, return the first clean parse. Guards
// against single-vendor rate limits / CORS hiccups seen in WKWebView.
const GEO_SOURCES: Array<{
  name: string;
  url: string;
  parse: (d: Record<string, unknown>) => GeoLookup | null;
}> = [
  {
    name: "ipapi.co",
    url: "https://ipapi.co/json/",
    parse: (d) => {
      const lat = Number((d as { latitude?: unknown }).latitude);
      const lon = Number((d as { longitude?: unknown }).longitude);
      const city = (d as { city?: string }).city;
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, city };
      return null;
    },
  },
  {
    name: "geojs.io",
    url: "https://get.geojs.io/v1/ip/geo.json",
    parse: (d) => {
      const lat = parseFloat(String((d as { latitude?: unknown }).latitude));
      const lon = parseFloat(String((d as { longitude?: unknown }).longitude));
      const city = (d as { city?: string }).city;
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, city };
      return null;
    },
  },
  {
    name: "ipwho.is",
    url: "https://ipwho.is/",
    parse: (d) => {
      const lat = Number((d as { latitude?: unknown }).latitude);
      const lon = Number((d as { longitude?: unknown }).longitude);
      const city = (d as { city?: string }).city;
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, city };
      return null;
    },
  },
];

function formatWeatherError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

async function lookupGeo(): Promise<GeoLookup | null> {
  const failures: string[] = [];
  for (const source of GEO_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) {
        failures.push(`${source.name} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const parsed = source.parse(data);
      if (parsed) return parsed;
      failures.push(`${source.name} returned unparseable payload`);
    } catch (err) {
      failures.push(`${source.name} fetch failed: ${formatWeatherError(err)}`);
    }
  }
  console.warn("[weather] all geo sources failed — widget will stay hidden", { failures });
  return null;
}

/** IP 定位 + open-meteo 当前天气 → snapshot;失败返回 null(各端 widget 隐藏)。 */
export async function fetchWeather(): Promise<WeatherSnapshot | null> {
  const geo = await lookupGeo();
  if (!geo) return null;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code&timezone=auto`,
    );
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code: number = data.current.weather_code;
    const meta = weatherMeta(code);
    return { temp, label: meta.label, iconKey: meta.iconKey, city: geo.city };
  } catch (err) {
    console.warn("[weather] open-meteo fetch failed:", err);
    return null;
  }
}
