import type {
  DeviceHealthObservationInput,
  DeviceHealthReplaceScope,
} from "../raw-db.js";
import type { DeviceIngestItem } from "./policies.js";

function strField(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberField(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function parseHealthObservations(item: DeviceIngestItem): DeviceHealthObservationInput[] {
  const payload = item.payload ?? {};
  const rows = Array.isArray(payload.observations) ? payload.observations : [];
  const payloadLocalDate = strField(payload, "local_date", "localDate");
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const observationType = strField(row, "observation_type", "observationType");
      if (!observationType) return null;
      const localDate = strField(row, "local_date", "localDate") ?? payloadLocalDate;
      return {
        id: strField(row, "id") ?? undefined,
        observationType,
        metric: strField(row, "metric") ?? undefined,
        value: numberField(row, "value") ?? undefined,
        unit: strField(row, "unit") ?? undefined,
        startAt: strField(row, "start_at", "startAt") ?? undefined,
        endAt: strField(row, "end_at", "endAt") ?? undefined,
        localDate: localDate ?? undefined,
        sourceApp: strField(row, "source_app", "sourceApp") ?? undefined,
        payload: row,
        occurredAt: strField(row, "occurred_at", "occurredAt") ?? item.occurredAt,
        dedupeKey: strField(row, "dedupe_key", "dedupeKey") ?? undefined,
      } satisfies DeviceHealthObservationInput;
    })
    .filter((row): row is DeviceHealthObservationInput => row !== null);
}

export function healthFullReplaceScope(item: DeviceIngestItem): DeviceHealthReplaceScope | null {
  const payloadLocalDate = strField(item.payload, "local_date", "localDate");
  if (payloadLocalDate) return { deviceId: item.deviceId, localDate: payloadLocalDate };

  const observations = parseHealthObservations(item);
  if (observations.length === 0) return null;
  const localDates = new Set(observations.map((row) => row.localDate).filter((v): v is string => !!v));
  if (localDates.size === 1 && observations.every((row) => !!row.localDate)) {
    return { deviceId: item.deviceId, localDate: [...localDates][0]! };
  }
  return null;
}
