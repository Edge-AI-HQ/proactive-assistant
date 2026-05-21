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
  AckPendingVisitsOptions,
  PendingVisit,
  PendingVisitsResult,
  PositionResult,
  VisitEvent,
  VisitMonitoringState,
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
export type { PendingVisit, SleepEvent, SoundClassification, StepsEvent, VisitEvent };

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
  sessionSilenceGapMs?: number;
  maxSessionDurationMs?: number;
  wavRetentionTtlMs?: number;
  wavMaxBytes?: number;
  wavMaxFiles?: number;
}

export interface AudioRoutePort {
  portType: string;
  portName: string;
  uid: string;
}

export interface AudioState {
  running: boolean;
  paused: boolean;
  capturing: boolean;
  suppressed: boolean;
  classificationRunning?: boolean;
  engineRunning?: boolean;
  capturePipelineRunning?: boolean;
  engineState?: 'stopped' | 'starting' | 'healthy' | 'stale' | 'failed' | 'suspended' | 'suppressed' | 'restarting';
  lastClassificationAt?: number;
  lastAudioError?: string;
  classifierRestartCount?: number;
  suppressedReason?: 'media' | 'playback' | 'interruption';
  backgroundCaptureLoopRunning?: boolean;
  currentCaptureTriggerSource?: string;
  routeInputs?: AudioRoutePort[];
  routeOutputs?: AudioRoutePort[];
  hasCarAudio?: boolean;
  hasBluetoothA2DP?: boolean;
  hasBluetoothHFP?: boolean;
}

export interface SpeechBurstEvent {
  confidence: number;
  durationMs: number;
  timestamp: number;
  triggerSource?: 'sound_analysis' | 'audio_vad_fallback' | string;
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
  triggerSource?: string;
}

export interface CaptureReadyEvent {
  platform: AmbientPlatform;
  wavId: string;
  burstId: string;
  captureSessionId: string;
  capturedAt: string;
  durationMs: number;
  byteSize: number;
  triggerSource?: string;
}

export interface CaptureDiscardedEvent {
  platform: AmbientPlatform;
  burstId: string;
  captureSessionId: string;
  capturedAt: string;
  durationMs: number;
  byteSize: number;
  triggerSource?: string;
  reason: 'silent_audio' | string;
  rms: number;
  peak: number;
  speechLikeFrameCount: number;
  speechLikeDurationMs: number;
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
  triggerSource?: string;
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
  triggerSource?: string;
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

export interface AudioCaptureReadResult {
  wavId: string;
  contentType: 'audio/wav';
  base64: string;
  byteSize: number;
}

export type ModelKind = 'asr' | 'llm';
export type ModelMirror = 'hf' | 'hf-mirror';
export type ModelMagic = 'GGUF' | 'ggml';
export type ModelDownloadState =
  | 'absent'
  | 'downloading'
  | 'paused'
  | 'present'
  | 'verifying'
  | 'failed';
export type ModelVerifyState = 'ok' | 'fail';

export interface ModelProfile {
  id: string;
  kind: ModelKind;
  displayName: string;
  repo: string;
  file: string;
  approxBytes: number;
  magic: ModelMagic;
  notes?: string;
}

export interface ModelDownloadStatus {
  id: string;
  state: ModelDownloadState;
  bytesWritten: number;
  bytesTotal: number;
  errorMessage?: string;
  mirrorInUse?: ModelMirror;
  sizeOnDisk?: number;
  lastVerifiedAt?: number;
  lastVerifyResult?: ModelVerifyState;
  lastVerifyOutput?: string;
  lastVerifyError?: string;
}

export interface ModelDownloadOptions {
  id: string;
  preferredMirror?: ModelMirror;
}

export interface ModelVerifyResult {
  id: string;
  ok: boolean;
  elapsedMs: number;
  output?: string;
  errorMessage?: string;
}

export interface ModelListResult {
  profiles: ModelProfile[];
  statuses: ModelDownloadStatus[];
}

export interface AmbientCandidateWindowForModel {
  id: string;
  localDate: string;
  timezone: string;
  windowType: string;
  startedAt: string;
  endedAt?: string;
  sourceTypes: string[];
  deviceLabels: string[];
  compactContext: string;
  privacyHint: 'normal' | 'private' | 'sensitive';
  confidenceHint: number;
  salienceHint: number;
  schemaVersion: 'ambient_candidate_window.v1';
}

export interface AmbientTimelineEventDraftResult {
  eventType: string;
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: 'certain' | 'uncertain';
  salientFacts: string[];
  actionCandidates?: unknown[];
  memoryCandidates?: string[];
  possibleCardTrigger?: { title: string; reason: string };
}

export interface GenerateTimelineEventOptions {
  modelId: string;
  window: AmbientCandidateWindowForModel;
}

export interface AmbientSummaryContextForModel {
  schemaVersion: 'ambient_summary.v1';
  localDate: string;
  generatedAt: string;
  rawEvents: Array<Record<string, unknown>>;
  recentSummaries?: Array<Record<string, unknown>>;
}

export interface GenerateAmbientSummaryEventOptions {
  modelId: string;
  context: AmbientSummaryContextForModel;
}

export interface AmbientTimelineBatchInput {
  schemaVersion: 'ambient_timeline_batch.v1';
  windows: AmbientCandidateWindowForModel[];
  recentLlmCards?: Array<Record<string, unknown>>;
  ruleContext?: Array<Record<string, unknown>>;
}

export interface GenerateTimelineBatchDecisionOptions {
  modelId: string;
  batch: AmbientTimelineBatchInput;
}

export interface AmbientTimelineBatchDecisionResult {
  decisions: unknown[];
}

export interface ModelDownloadProgressEvent extends ModelDownloadStatus {
  /** Server-side wall clock when the event was emitted. */
  emittedAt: number;
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
  captureReady: CaptureReadyEvent;
  captureDiscarded: CaptureDiscardedEvent;
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
  modelDownloadProgress: ModelDownloadProgressEvent;
  modelDownloadDone: ModelDownloadProgressEvent;
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
  readCapture(options: { wavId: string }): Promise<AudioCaptureReadResult>;
  markCaptureProcessed(options: { wavId: string }): Promise<void>;
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
  drainPendingVisits(options?: { limit?: number }): Promise<PendingVisitsResult>;
  ackPendingVisits(options: AckPendingVisitsOptions): Promise<void>;
  getMonitoringState(): Promise<VisitMonitoringState>;
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

export interface ModelsNamespace {
  list(): Promise<ModelListResult>;
  startDownload(options: ModelDownloadOptions): Promise<void>;
  cancelDownload(options: { id: string }): Promise<void>;
  deleteModel(options: { id: string }): Promise<void>;
  verifyModel(options: { id: string }): Promise<ModelVerifyResult>;
  generateTimelineEvent(options: GenerateTimelineEventOptions): Promise<AmbientTimelineEventDraftResult>;
  generateTimelineBatchDecision(options: GenerateTimelineBatchDecisionOptions): Promise<AmbientTimelineBatchDecisionResult>;
  generateAmbientSummaryEvent(options: GenerateAmbientSummaryEventOptions): Promise<AmbientTimelineEventDraftResult>;
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
  models: ModelsNamespace;
  addListener<K extends AmbientEventName>(
    eventName: K,
    listenerFunc: (event: AmbientEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const unavailablePermissions = <T extends string>(key: T): Record<T, PermissionState> =>
  ({ [key]: 'denied' }) as Record<T, PermissionState>;
