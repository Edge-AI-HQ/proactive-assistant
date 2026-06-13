// Lifted to @pin-ai/core (domain/ambient); re-exported here so existing
// "@/services/ambient/..." importers keep working unchanged. The SQLite store,
// pipeline runtime and local-model bridge stay in this app. Delete this shim
// when the Capacitor shell retires.
export * from "@pin-ai/core";
