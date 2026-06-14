import { useQuery } from "@tanstack/react-query";

import { fetchWeather, type WeatherSnapshot } from "@pin-ai/core";

export const weatherKeys = {
  all: ["weather"] as const,
};

const STALE_TIME_MS = 30 * 60 * 1000; // 30min,与原 web 端 sessionStorage TTL 一致

/**
 * 当前天气(IP 定位 + open-meteo)。平台无关 TQ hook,web / RN 共用。
 *
 * TQ 缓存替代原 ui-web 端的 sessionStorage:staleTime 30min;失败不重试
 * (geo 已在 fetchWeather 内多源兜底,失败即隐藏 widget),TQ 天然保留上次成功值;
 * 不随窗口聚焦刷新(天气变化慢,省外部 API 调用)。
 *
 * 返回平台无关 snapshot(含语义 iconKey)。web 端 ui-web/now/useWeather 再包一层
 * 把 iconKey 绑成 lucide 图标;RN 自绑 lucide-react-native。
 */
export function useWeatherData(): WeatherSnapshot | null {
  const { data } = useQuery({
    queryKey: weatherKeys.all,
    queryFn: fetchWeather,
    staleTime: STALE_TIME_MS,
    gcTime: STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}
