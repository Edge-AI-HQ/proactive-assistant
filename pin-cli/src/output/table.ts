import type { PinEnvelope } from "./envelope.js";

export const formatAsTable = <T>(envelope: PinEnvelope<T>): string => {
  if (!envelope.ok && envelope.error) {
    return `ERROR [${envelope.error.code}]: ${envelope.error.message}`;
  }

  if (!envelope.data) return "(no data)";

  if (Array.isArray(envelope.data)) {
    return formatListTable(envelope.data);
  }

  if (typeof envelope.data === "object") {
    return formatKvTable(envelope.data as Record<string, unknown>);
  }

  return String(envelope.data);
};

const formatKvTable = (data: Record<string, unknown>): string => {
  const entries = Object.entries(data);
  if (entries.length === 0) return "(empty)";

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([k, v]) => {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      return `${k.padEnd(maxKeyLen)}  ${val}`;
    })
    .join("\n");
};

const formatListTable = (items: unknown[]): string => {
  if (items.length === 0) return "(empty)";

  const rows = items.map((item) => {
    if (item && typeof item === "object") {
      return item as Record<string, unknown>;
    }
    return { value: item };
  });

  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (cols.length === 0) return "(empty)";

  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => cellValue(r[col]).length)),
  );

  const header = cols.map((col, i) => col.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) =>
      cols.map((col, i) => cellValue(row[col]).padEnd(widths[i])).join("  "),
    )
    .join("\n");

  return `${header}\n${separator}\n${body}`;
};

const cellValue = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
