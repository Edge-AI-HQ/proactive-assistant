// Lifted to @pin-ai/core (domain/ambient); re-exported here so existing
// "@/services/ambient/sources/types" importers keep working unchanged. The
// SourceContext / AmbientSource port contracts are shared by every native
// source; the concrete source implementations stay in this app. Delete this
// shim when the Capacitor shell retires.
export * from "@pin-ai/core";
