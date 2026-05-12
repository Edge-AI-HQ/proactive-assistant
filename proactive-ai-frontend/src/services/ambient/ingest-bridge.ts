import {
  ensureDevice,
  ingestSignals,
  type IngestResult,
  type PersonalSignalInput,
} from "@/lib/devices";

export type IngestStats = IngestResult;

/**
 * Push a batch up to /api/devices/ingest using the device credentials
 * stored after first launch (`ensureDevice` is idempotent after the
 * first call, hitting secure storage only).
 */
export async function ingestBatch(
  items: PersonalSignalInput[],
): Promise<IngestStats> {
  if (items.length === 0) {
    return { ok: true, accepted: 0, inserted: 0, ignored: 0, results: [] };
  }
  const creds = await ensureDevice();
  return ingestSignals(creds, items);
}
