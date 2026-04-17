import { useState, useEffect } from "react";
import {
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, CloudFog,
  type LucideIcon,
} from "lucide-react";

export interface WeatherData {
  temp: number;
  label: string;
  icon: LucideIcon;
  city?: string;
}

const CACHE_KEY = "proactive-ai:weather";
const CACHE_TTL = 30 * 60 * 1000;

function weatherMeta(code: number): { label: string; icon: LucideIcon } {
  if (code === 0) return { label: "Clear", icon: Sun };
  if (code <= 3) return { label: "Cloudy", icon: Cloud };
  if (code <= 48) return { label: "Foggy", icon: CloudFog };
  if (code <= 57) return { label: "Drizzle", icon: CloudDrizzle };
  if (code <= 67) return { label: "Rainy", icon: CloudRain };
  if (code <= 77) return { label: "Snowy", icon: CloudSnow };
  if (code <= 82) return { label: "Showers", icon: CloudRain };
  if (code >= 95) return { label: "Stormy", icon: CloudLightning };
  return { label: "Cloudy", icon: Cloud };
}

interface CachedWeather {
  temp: number;
  code: number;
  city?: string;
  ts: number;
}

function readCache(): CachedWeather | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedWeather = JSON.parse(raw);
    if (Date.now() - cached.ts > CACHE_TTL) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(data: CachedWeather) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

interface GeoLookup {
  lat: number;
  lon: number;
  city?: string;
}

// Multi-source IP geolocation. All must be HTTPS — iOS App Transport
// Security blocks plain HTTP. We try each source in order and return the
// first response that parses cleanly. This protects against single-vendor
// rate limits / CORS hiccups seen in WKWebView.
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

async function lookupGeo(): Promise<GeoLookup | null> {
  for (const source of GEO_SOURCES) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) {
        console.warn(`[weather] ${source.name} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const parsed = source.parse(data);
      if (parsed) return parsed;
      console.warn(`[weather] ${source.name} returned unparseable payload`, data);
    } catch (err) {
      console.warn(`[weather] ${source.name} fetch failed:`, err);
    }
  }
  return null;
}

export function useWeather(): WeatherData | null {
  const [weather, setWeather] = useState<WeatherData | null>(() => {
    const cached = readCache();
    if (!cached) return null;
    const meta = weatherMeta(cached.code);
    return { temp: cached.temp, label: meta.label, icon: meta.icon, city: cached.city };
  });

  useEffect(() => {
    if (readCache()) return;

    let cancelled = false;

    async function fetchWeather() {
      const geo = await lookupGeo();
      if (!geo) {
        console.warn("[weather] all geo sources failed — widget will stay hidden");
        return;
      }
      try {
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code&timezone=auto`,
        );
        const data = await res.json();
        const temp = Math.round(data.current.temperature_2m);
        const code: number = data.current.weather_code;

        if (cancelled) return;

        writeCache({ temp, code, city: geo.city, ts: Date.now() });
        const meta = weatherMeta(code);
        setWeather({ temp, label: meta.label, icon: meta.icon, city: geo.city });
      } catch (err) {
        console.warn("[weather] open-meteo fetch failed:", err);
      }
    }

    fetchWeather();
    return () => { cancelled = true; };
  }, []);

  return weather;
}
