// Lifted to @pin-ai/core (domain/ambient); re-exported here so existing
// "@/services/ambient/sources/motion-segments" importers keep working
// unchanged. The native motion source stays in this app and feeds
// ActivityEvent samples (structurally a MotionActivityEvent) into
// MotionSegmentAggregator. Delete this shim when the Capacitor shell retires.
export * from "@pin-ai/core";
