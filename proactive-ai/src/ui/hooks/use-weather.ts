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
const CACHE_TTL = 30 * 60 * 1000; // 30 min

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

    async function fetch_weather() {
      try {
        const geo = await fetch("http://ip-api.com/json/?fields=lat,lon,city").then((r) => r.json());
        const lat = geo.lat;
        const lon = geo.lon;
        const city: string | undefined = geo.city;

        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`,
        );
        const data = await res.json();
        const temp = Math.round(data.current.temperature_2m);
        const code: number = data.current.weather_code;

        if (cancelled) return;

        writeCache({ temp, code, city, ts: Date.now() });
        const meta = weatherMeta(code);
        setWeather({ temp, label: meta.label, icon: meta.icon, city });
      } catch {
        /* silently fail — weather is non-critical */
      }
    }

    fetch_weather();
    return () => { cancelled = true; };
  }, []);

  return weather;
}
