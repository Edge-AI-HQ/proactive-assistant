/**
 * ambient-visit（Expo local module）的 JS 绑定：CLVisit 监听（durable
 * drain/ack 队列）+ CMMotionActivity 识别。Swift 核心迁移自
 * capacitor-plugins/ambient-ai 的 VisitMonitorPlugin。
 */
import { requireNativeModule, type EventSubscription } from "expo-modules-core";

export interface VisitEvent {
  id: string;
  arrivalAt: number;
  departureAt: number | null;
  latitude: number;
  longitude: number;
  accuracy: number;
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

export const AmbientVisit = requireNativeModule<AmbientVisitModuleType>("AmbientVisit");
