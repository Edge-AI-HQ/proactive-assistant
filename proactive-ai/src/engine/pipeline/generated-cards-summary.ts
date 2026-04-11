import { listRecentGeneratedCards } from "./data-access.js";

interface GeneratedCardRecord {
  goalBasket?: string | null;
  title?: string | null;
  titleKey?: string | null;
  generatedAt?: string | null;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function formatDate(iso: string | null): string {
  if (!iso) return "unknown-date";
  return iso.slice(0, 10);
}

export async function loadRecentGeneratedCardsSummary(
  options?: { limit?: number; since?: string },
): Promise<string> {
  const rawRecords = await listRecentGeneratedCards({
    limit: String(options?.limit ?? 10),
    since: options?.since,
  });

  const records = (rawRecords as GeneratedCardRecord[]) ?? [];
  if (records.length === 0) return "";

  return records
    .map((record) => {
      const basket = asString(record.goalBasket) ?? "unknown";
      const titleKey = asString(record.titleKey) ?? "unknown";
      const title = asString(record.title) ?? "Untitled card";
      return `- ${basket}: ${titleKey} | ${formatDate(asString(record.generatedAt))} | ${title}`;
    })
    .join("\n");
}
