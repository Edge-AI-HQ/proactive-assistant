/**
 * RN timeline store 单例：core 的 DatabasePort 背书 SqliteTimelineStore +
 * createExpoDatabase（和 ambient/ingest.ts 的 SqliteOutboxStore 同模式）。
 * durable（expo-sqlite），对齐 web 在 native 用 SqliteTimelineStore 的能力，
 * 不用会丢数据的 MemoryTimelineStore。
 */
import { SqliteTimelineStore, type AmbientTimelineStore } from "@pin-ai/core";

import { createExpoDatabase } from "../../lib/sync/expo-database";

let singleton: AmbientTimelineStore | null = null;

export function getAmbientTimelineStore(): AmbientTimelineStore {
  if (!singleton) {
    singleton = new SqliteTimelineStore(createExpoDatabase("ambient_timeline"));
  }
  return singleton;
}
