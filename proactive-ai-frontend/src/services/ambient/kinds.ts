/**
 * PersonalSignal `kind` strings for ambient device sources.
 *
 * Naming follows the iOS integration guide: `<source_class>.<event_name>`,
 * snake_case. The container backend routes by `kind` and does not validate
 * payload shape, so adding a new kind here is a frontend-only change.
 */
export const SIGNAL_KINDS = {
  soundClassification: "device.sound_classification",
  soundSceneRun: "device.sound_scene_run",
  visit: "device.visit",
  activity: "device.activity",
  motionSegment: "device.motion_segment",
  location: "device.location",
  timelineEvent: "ambient.timeline_event",
  candidateWindow: "ambient.candidate_window",
  calendarEvent: "device.calendar_event",
  focusState: "device.focus_state",
  audioRoute: "device.audio_route",
  deviceState: "device.device_state",
} as const;

export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];
