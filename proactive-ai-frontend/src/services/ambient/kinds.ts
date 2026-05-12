/**
 * PersonalSignal `kind` strings for ambient device sources.
 *
 * Naming follows the iOS integration guide: `<source_class>.<event_name>`,
 * snake_case. The container backend routes by `kind` and does not validate
 * payload shape, so adding a new kind here is a frontend-only change.
 */
export const SIGNAL_KINDS = {
  soundClassification: "device.sound_classification",
  visit: "device.visit",
  activity: "device.activity",
  location: "device.location",
} as const;

export type SignalKind = (typeof SIGNAL_KINDS)[keyof typeof SIGNAL_KINDS];
