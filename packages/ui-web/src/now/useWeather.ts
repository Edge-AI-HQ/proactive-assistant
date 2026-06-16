import {
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, CloudFog,
  type LucideIcon,
} from "lucide-react";
import { type WeatherConditionKey, type WeatherIconKey } from "@pin-ai/core";
import { useWeatherData } from "@pin-ai/state";

export interface WeatherData {
  temp: number;
  label: string;
  icon: LucideIcon;
  /** i18n 键(common.json weather.*)。消费方绑 i18n;`label` 是英文回落。 */
  conditionKey: WeatherConditionKey;
  city?: string;
}

/** core 语义 iconKey → lucide web 图标。RN 用 lucide-react-native 自绑同一组键。 */
const WEATHER_ICONS: Record<WeatherIconKey, LucideIcon> = {
  sun: Sun,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  lightning: CloudLightning,
};

/**
 * 天气逻辑 + 获取已下沉 @pin-ai/core(domain/weather)+ @pin-ai/state
 * (useWeatherData,TQ 缓存)。这里只把 snapshot 的 iconKey 绑成 lucide,
 * 产出 web 消费方(AppLayout / ZebraShell)要的 WeatherData。
 */
export function useWeather(): WeatherData | null {
  const snapshot = useWeatherData();
  if (!snapshot) return null;
  return {
    temp: snapshot.temp,
    label: snapshot.label,
    icon: WEATHER_ICONS[snapshot.iconKey],
    conditionKey: snapshot.conditionKey,
    city: snapshot.city,
  };
}
