// The pipeline class + pure helpers now live in @pin-ai/core
// (domain/ambient/pipeline); re-exported here so existing "@/services/ambient/..."
// importers keep working unchanged. The factories below stay in this app because
// they wire the Capacitor SQLite store (getAmbientTimelineStore) and the native
// model bridge (ambientTimelineModels) as defaults. Delete this shim when the
// Capacitor shell retires.
import {
  LocalAmbientTimelinePipeline,
  type AmbientTimelinePipeline,
  type AmbientTimelinePipelineOptions,
} from "@pin-ai/core";
import { ambientTimelineModels } from "./models";
import { getAmbientTimelineStore } from "./store";

export {
  LocalAmbientTimelinePipeline,
  todayLocalDate,
} from "@pin-ai/core";
export type {
  AmbientTimelinePipeline,
  AmbientTimelinePipelineOptions,
  AmbientTimelineProcessOptions,
} from "@pin-ai/core";

export function createAmbientTimelinePipeline(
  options: AmbientTimelinePipelineOptions = {},
): AmbientTimelinePipeline {
  return new LocalAmbientTimelinePipeline(
    options.store ?? getAmbientTimelineStore(),
    options.modelBridge ?? ambientTimelineModels,
    { now: options.now },
  );
}

let singleton: AmbientTimelinePipeline | null = null;

export function getAmbientTimelinePipeline(): AmbientTimelinePipeline {
  if (!singleton) singleton = createAmbientTimelinePipeline();
  return singleton;
}
