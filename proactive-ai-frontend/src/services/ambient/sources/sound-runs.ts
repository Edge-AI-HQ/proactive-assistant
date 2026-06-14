// Lifted to @pin-ai/core (domain/ambient); re-exported here so existing
// "@/services/ambient/sources/sound-runs" importers keep working unchanged.
// The native sound-classifier source stays in this app and feeds samples into
// SoundRunAggregator. Delete this shim when the Capacitor shell retires.
export * from "@pin-ai/core";
