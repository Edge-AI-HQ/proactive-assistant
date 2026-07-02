/**
 * 地名显示逻辑（从 web sources/location.ts 逐字移植：resolveDisplayPlace +
 * candidatePlaces）。输入 = 原生 GeocodeService 的 PlaceInfo（CLGeocoder 行政字段
 * + MapKit POI 候选带距离），输出 = 一个保守的 display_place（exact_place /
 * nearby_poi / area / coordinates 四档）。
 *
 * 暂放 RN 本地、未上移 @pin-ai/core：dev(proactive-ai-frontend) 是当前生产 iOS，
 * 动它要重部署 prod；RN 到 parity 后 dev 会被删。这是暂时的 SSOT 重复。
 */
import type { PlaceInfo } from "../../../modules/ambient-visit";

export interface DisplayPlace {
  mode: "exact_place" | "nearby_poi" | "area" | "coordinates";
  label: string;
  confidence: number;
}

interface PlaceCandidateLike {
  name: string;
  distance_m: number;
  category?: string;
  confidence?: number;
}

/**
 * 从 PlaceInfo + 定位精度挑一个展示安全的地名。严格对齐 web：只有当 fix 足够精确
 * 且 POI 足够近才敢显示具体地标，否则退回区域 / 地址 / 坐标。
 */
export function resolveDisplayPlace(input: {
  latitude: number;
  longitude: number;
  accuracy: number;
  candidate?: PlaceCandidateLike;
  address?: string;
  area?: string;
}): DisplayPlace {
  const coordinateLabel = `${input.latitude.toFixed(4)}, ${input.longitude.toFixed(4)} ±${Math.round(input.accuracy)}m`;
  const candidate = input.candidate;
  if (candidate && input.accuracy <= 25 && candidate.distance_m <= 25) {
    return { mode: "exact_place", label: candidate.name, confidence: 0.9 };
  }
  if (
    candidate &&
    candidate.distance_m <= 80 &&
    candidate.distance_m <= Math.max(input.accuracy * 1.5, 50)
  ) {
    return {
      mode: "nearby_poi",
      label: `Near ${candidate.name}`,
      confidence: 0.65,
    };
  }
  const areaLabel = input.area ?? input.address;
  if (areaLabel) return { mode: "area", label: areaLabel, confidence: 0.7 };
  return { mode: "coordinates", label: coordinateLabel, confidence: 0.5 };
}

function candidatePlaces(place: PlaceInfo | null): PlaceCandidateLike[] {
  const candidates = Array.isArray(place?.candidates) ? place.candidates : [];
  const normalized: PlaceCandidateLike[] = [];
  // 原生桥返回的是边界数据，仍按 typeof 防御性读取（对齐 web candidatePlaces）。
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const distance =
      typeof candidate.distance_m === "number" && Number.isFinite(candidate.distance_m)
        ? candidate.distance_m
        : null;
    if (!name || distance === null) continue;
    normalized.push({
      name,
      distance_m: distance,
      category: typeof candidate.category === "string" ? candidate.category : undefined,
      confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined,
    });
    if (normalized.length >= 5) break;
  }
  if (normalized.length > 0) return normalized;
  if (place?.poi_name && typeof place.poi_distance_m === "number") {
    return [
      {
        name: place.poi_name,
        distance_m: place.poi_distance_m,
        category: place.poi_category,
      },
    ];
  }
  return [];
}

/**
 * 把一次定位 fix + PlaceInfo 组装成 location 信号的 { summary, payload }。
 * payload 形状对齐 web sources/location.ts（display_place / place / place_candidates /
 * place_resolution / location_fix），喂共享 normalize + live 卡 + 后端 ingest。
 */
export function buildLocationSignal(
  fix: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    altitude: number | null;
    speed: number | null;
    heading: number | null;
  },
  place: PlaceInfo | null,
): { summary: string; payload: Record<string, unknown> } {
  // expo 的 accuracy 可能为 null；给一个大值，避免 null<=25 被误判成 exact_place。
  const accuracy = typeof fix.accuracy === "number" && Number.isFinite(fix.accuracy)
    ? fix.accuracy
    : 9999;
  const placeCandidates = candidatePlaces(place);
  const displayPlace = resolveDisplayPlace({
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy,
    candidate: placeCandidates[0],
    address: place?.address,
    area: place?.area_of_interest ?? place?.sub_locality ?? place?.locality,
  });
  return {
    summary: displayPlace.label,
    payload: {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      altitude: fix.altitude,
      speed: fix.speed,
      heading: fix.heading,
      place: place ?? undefined,
      location_fix: { latitude: fix.latitude, longitude: fix.longitude, accuracy },
      place_candidates: placeCandidates,
      display_place: displayPlace,
      place_resolution: {
        strategy: place?.resolution_strategy ?? "reverse_geocode",
        source: place?.source ?? "apple_mapkit",
      },
    },
  };
}
