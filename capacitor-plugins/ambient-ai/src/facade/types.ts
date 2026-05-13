import type { PluginListenerHandle, PermissionState } from '@capacitor/core';

import type {
  AmbientLevelEvent,
  AudioAmbientPermissions,
} from '../modules/audio-ambient/definitions';
import type {
  BatterySnapshot,
  BatteryStartOptions,
} from '../modules/battery/definitions';
import type {
  CalendarEventEvent,
  CalendarPermissions,
  CalendarSummaryEvent,
} from '../modules/calendar/definitions';
import type {
  ContactsPermissions,
  ContactsSnapshot,
} from '../modules/contacts/definitions';
import type {
  DeviceStateSnapshot,
} from '../modules/device-state/definitions';
import type {
  PlaceInfo,
  ReverseGeocodeOptions,
} from '../modules/geocoder/definitions';
import type {
  HealthConnectPermissions,
  HeartRateEvent,
  SleepEvent,
  StepsEvent,
} from '../modules/health-connect/definitions';
import type {
  MediaNotebookPermissions,
  PhotosEvent,
} from '../modules/media-notebook/definitions';
import type {
  NearbyBTEvent,
  NearbyConnectivityPermissions,
} from '../modules/nearby-connectivity/definitions';
import type {
  FocusEvent,
  NotificationCountEvent,
  NotificationUsagePermissions,
} from '../modules/notification-usage/definitions';
import type {
  AltimeterEvent,
  SensorFusionPermissions,
} from '../modules/sensor-fusion/definitions';
import type {
  SoundClassification,
  SoundClassifierEvent,
  SoundClassifierPermissions,
} from '../modules/sound-classifier/definitions';
import type {
  ActivityEvent,
  PositionResult,
  VisitEvent,
  VisitMonitorPermissions,
} from '../modules/visit-monitor/definitions';

export type AmbientPlatform = 'ios' | 'android' | 'web';
export type TranscriptProvider = 'local_speech' | 'cloud_whisper';
export type LocalSpeechProvider = 'sfspeech' | 'android_speech';

export type AudioPermissions = AudioAmbientPermissions;
export type SoundPermissions = SoundClassifierPermissions;
export type VisitPermissions = VisitMonitorPermissions;
export type CalendarPermissionsResult = CalendarPermissions;
export type MediaPermissions = MediaNotebookPermissions;
export type NearbyPermissions = NearbyConnectivityPermissions;
export type NotificationsPermissions = NotificationUsagePermissions;
export type SensorPermissions = SensorFusionPermissions;
export type HealthPermissions = HealthConnectPermissions;
export type ContactsPermissionsResult = ContactsPermissions;

export type { ActivityEvent, AltimeterEvent, AmbientLevelEvent, BatterySnapshot };
export type { BatteryStartOptions, CalendarEventEvent, CalendarSummaryEvent };
export type { ContactsSnapshot, DeviceStateSnapshot, FocusEvent, HeartRateEvent };
export type { NearbyBTEvent, NotificationCountEvent, PhotosEvent, PositionResult };
export type { PlaceInfo, ReverseGeocodeOptions };
export type { SleepEvent, SoundClassification, StepsEvent, VisitEvent };

export type SoundClassificationEvent = SoundClassifierEvent;

export interface AudioCaptureConfig {
  cloudMode?: 'off' | 'devDirect' | 'proxy';
  recognitionLocale?: string;
  cloudApiKey?: string;
  cloudBaseURL?: string;
  modelName?: string;
  cloudRefineTimeoutMs?: number;
  preRollMs?: number;
  postRollMs?: number;
  maxBurstMs?: number;
  minBurstMs?: number;
  wavRetentionTtlMs?: number;
  wavMaxBytes?: number;
  wavMaxFiles?: number;
}

export interface AudioState {
  running: boolean;
  paused: boolean;
  capturing: boolean;
  suppressed: boolean;
  suppressedReason?: 'media' | 'playback' | 'interruption';
}

export interface SpeechBurstEvent {
  confidence: number;
  durationMs: number;
  timestamp: number;
}

export interface TranscriptDraftEvent {
  platform: AmbientPlatform;
  wavId: string;
  burstId: string;
  captureSessionId: string;
  text: string;
  capturedAt: string;
  durationMs: number;
  transcriptLocale?: string;
}

export interface TranscriptRefinedEvent {
  platform: AmbientPlatform;
  wavId: string;
  burstId: string;
  captureSessionId: string;
  refinedText: string;
  capturedAt: string;
  provider: TranscriptProvider;
  localProvider?: LocalSpeechProvider;
  transcriptLocale?: string;
}

export interface TranscriptReadyEvent {
  platform: AmbientPlatform;
  wavId: string;
  burstId: string;
  captureSessionId: string;
  text: string;
  capturedAt: string;
  durationMs: number;
  provider: TranscriptProvider;
  fallback: boolean;
  localProvider?: LocalSpeechProvider;
  segmentIndex?: number;
  transcriptLocale?: string;
}

export interface AudioErrorEvent {
  message: string;
  source: string;
}

export interface RecentAudioCapture {
  wavId: string;
  burstId?: string;
  captureSessionId?: string;
  capturedAt: string;
  durationMs: number;
  byteSize: number;
}

export interface AmbientEventMap {
  activity: ActivityEvent;
  altimeter: AltimeterEvent;
  ambientLevel: AmbientLevelEvent;
  audioError: AudioErrorEvent;
  audioState: AudioState;
  battery: BatterySnapshot;
  calendarEvent: CalendarEventEvent;
  calendarSummary: CalendarSummaryEvent;
  contacts: ContactsSnapshot;
  deviceState: DeviceStateSnapshot;
  focus: FocusEvent;
  heartRate: HeartRateEvent;
  nearbyBT: NearbyBTEvent;
  notifications: NotificationCountEvent;
  photos: PhotosEvent;
  sleep: SleepEvent;
  soundClassification: SoundClassificationEvent;
  speechBurst: SpeechBurstEvent;
  steps: StepsEvent;
  transcriptDraft: TranscriptDraftEvent;
  transcriptReady: TranscriptReadyEvent;
  transcriptRefined: TranscriptRefinedEvent;
  visit: VisitEvent;
}

export type AmbientEventName = keyof AmbientEventMap;

export interface AudioNamespace {
  requestPermissions(): Promise<AudioPermissions>;
  checkPermissions(): Promise<AudioPermissions>;
  configure(config: AudioCaptureConfig): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  getState(): Promise<AudioState>;
  drainPendingTranscripts(): Promise<TranscriptReadyEvent[]>;
  listRecentCaptures(): Promise<{ captures: RecentAudioCapture[] }>;
  playCapture(options: { wavId: string }): Promise<void>;
  stopPlayback(): Promise<void>;
}

export interface SoundNamespace {
  requestPermissions(): Promise<SoundPermissions>;
  checkPermissions(): Promise<SoundPermissions>;
  startClassification(): Promise<void>;
  stopClassification(): Promise<void>;
}

export interface VisitNamespace {
  requestPermissions(): Promise<VisitPermissions>;
  checkPermissions(): Promise<VisitPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  getCurrentPosition(): Promise<PositionResult>;
  startActivityRecognition(): Promise<void>;
  stopActivityRecognition(): Promise<void>;
}

export interface GeocoderNamespace {
  reverseGeocode(options: ReverseGeocodeOptions): Promise<PlaceInfo>;
}

export interface DeviceNamespace {
  getState(): Promise<DeviceStateSnapshot>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface CalendarNamespace {
  requestPermissions(): Promise<CalendarPermissionsResult>;
  checkPermissions(): Promise<CalendarPermissionsResult>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface NotificationsNamespace {
  requestPermissions(): Promise<NotificationsPermissions>;
  checkPermissions(): Promise<NotificationsPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface MediaNamespace {
  requestPermissions(): Promise<MediaPermissions>;
  checkPermissions(): Promise<MediaPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface NearbyNamespace {
  requestPermissions(): Promise<NearbyPermissions>;
  checkPermissions(): Promise<NearbyPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface SensorNamespace {
  requestPermissions(): Promise<SensorPermissions>;
  checkPermissions(): Promise<SensorPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface HealthNamespace {
  requestPermissions(): Promise<HealthPermissions>;
  checkPermissions(): Promise<HealthPermissions>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface BatteryNamespace {
  getState(): Promise<BatterySnapshot>;
  startMonitoring(options?: BatteryStartOptions): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface ContactsNamespace {
  requestPermissions(): Promise<ContactsPermissionsResult>;
  checkPermissions(): Promise<ContactsPermissionsResult>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
}

export interface AmbientAiFacade {
  audio: AudioNamespace;
  sound: SoundNamespace;
  visit: VisitNamespace;
  geocoder: GeocoderNamespace;
  device: DeviceNamespace;
  calendar: CalendarNamespace;
  notifications: NotificationsNamespace;
  media: MediaNamespace;
  nearby: NearbyNamespace;
  sensor: SensorNamespace;
  health: HealthNamespace;
  battery: BatteryNamespace;
  contacts: ContactsNamespace;
  addListener<K extends AmbientEventName>(
    eventName: K,
    listenerFunc: (event: AmbientEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const unavailablePermissions = <T extends string>(key: T): Record<T, PermissionState> =>
  ({ [key]: 'denied' }) as Record<T, PermissionState>;
