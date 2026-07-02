/**
 * ambient-visit（Expo local module）的 JS 绑定：CLVisit 监听（durable
 * drain/ack 队列）+ CMMotionActivity 识别。Swift 核心迁移自
 * capacitor-plugins/ambient-ai 的 VisitMonitorPlugin。
 */
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * 反地理编码结果（原生 GeocodeService.toDict()，与 capacitor
 * @pin/capacitor-ambient-ai geocoder/definitions.ts 的 PlaceInfo 同形）。
 * CLGeocoder 行政字段 + MapKit POI 候选（带距离）融合。
 */
export interface PlaceCandidate {
  name: string;
  category?: string;
  distance_m: number;
  source: string;
  confidence: number;
}

export interface PlaceInfo {
  /** 原生拼的多段 label（poi/area/address 去重，最多 3 段）。 */
  label?: string;
  /** 单名字段：poi_name ?? area_of_interest ?? placemark.name。 */
  place_name?: string;
  address?: string;
  poi_name?: string;
  poi_category?: string;
  poi_distance_m?: number;
  candidates?: PlaceCandidate[];
  resolution_strategy?: "structured_poi" | "reverse_geocode" | "coordinates";
  area_of_interest?: string;
  areas_of_interest?: string[];
  thoroughfare?: string;
  sub_thoroughfare?: string;
  locality?: string;
  sub_locality?: string;
  administrative_area?: string;
  postal_code?: string;
  country?: string;
  country_code?: string;
  source: string;
  resolved_at: number;
}

export interface VisitEvent {
  id: string;
  arrivalAt: number;
  departureAt: number | null;
  latitude: number;
  longitude: number;
  accuracy: number;
  /** 原生到访时 GeocodeService 反编码补全（placeStatus=resolved 后携带）。 */
  place?: PlaceInfo;
}

export interface ActivityEvent {
  type: "automotive" | "cycling" | "running" | "walking" | "stationary";
  confidence: "high" | "medium" | "low";
  timestamp: number;
}

export interface FocusEvent {
  focused: boolean;
  timestamp: number;
}

export interface PendingVisit {
  id: string;
  payload: VisitEvent;
}

export interface VisitMonitoringState {
  pendingVisitCount: number;
  storedVisitCount: number;
  lastNativeVisitAt: number | null;
  lastDrainAt: number | null;
  authorization: "always" | "when_in_use" | "denied" | "restricted" | "prompt";
  nativeMonitoring: boolean;
  enabled: boolean;
  lastError: string | null;
}

interface AmbientVisitModuleType {
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  drainPendingVisits(limit: number): Promise<PendingVisit[]>;
  ackPendingVisits(ids: string[]): Promise<void>;
  reverseGeocode(latitude: number, longitude: number): Promise<PlaceInfo>;
  getMonitoringState(): Promise<VisitMonitoringState>;
  startActivityRecognition(): Promise<void>;
  stopActivityRecognition(): Promise<void>;
  requestFocusPermissions(): Promise<string>;
  startFocusMonitoring(): Promise<void>;
  stopFocusMonitoring(): Promise<void>;
  addListener(eventName: "visit", listener: (event: VisitEvent) => void): EventSubscription;
  addListener(eventName: "activity", listener: (event: ActivityEvent) => void): EventSubscription;
  addListener(eventName: "focus", listener: (event: FocusEvent) => void): EventSubscription;
}

// Swift 核心未链接的 build（模块 ios/ 源不在该机器）里不让 import 即炸——
// 调用时才抛清晰错误（web 端 native-plugin-stub Proxy 同款 pattern）。
export const AmbientVisit =
  requireOptionalNativeModule<AmbientVisitModuleType>("AmbientVisit") ??
  (new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `AmbientVisit native module unavailable (Swift core not linked in this build): ${String(prop)}`,
        );
      },
    },
  ) as AmbientVisitModuleType);
