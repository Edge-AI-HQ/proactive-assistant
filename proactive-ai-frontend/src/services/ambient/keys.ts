/**
 * Side-effect-free constants + types for the ambient runtime.
 *
 * Lives outside ``./index`` so UI modules (e.g. AmbientView) can
 * statically reference ``ALL_SOURCE_KEYS`` / ``SourceKey`` without
 * pulling the source implementations (and their native-plugin imports)
 * into the main web bundle. The runtime itself is still loaded via
 * dynamic import behind an ``isNative`` guard.
 */

export type SourceKey =
  | "sound_classifier"
  | "visit"
  | "activity"
  | "location"
  | "health"
  | "calendar"
  | "focus"
  | "audio_route"
  | "device_state";

export const DEFAULT_AUTO_START_SOURCES: SourceKey[] = [
  "sound_classifier",
  "visit",
  "activity",
  "location",
];

export const ALL_SOURCE_KEYS: SourceKey[] = [
  ...DEFAULT_AUTO_START_SOURCES,
  "health",
  "calendar",
  "focus",
  "audio_route",
  "device_state",
];
