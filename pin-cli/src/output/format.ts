import type { PinEnvelope } from "./envelope.js";
import { formatAsTable } from "./table.js";

export type OutputFormat = "json" | "table" | "ndjson" | "pretty";

export const parseFormat = (raw?: string): OutputFormat => {
  if (raw === "table" || raw === "ndjson" || raw === "pretty") return raw;
  return "json";
};

export const formatEnvelope = <T>(
  envelope: PinEnvelope<T>,
  format: OutputFormat,
): string => {
  switch (format) {
    case "table":
      return formatAsTable(envelope);
    case "ndjson":
      return formatNdjson(envelope);
    case "pretty":
      return formatPretty(envelope);
    case "json":
    default:
      return JSON.stringify(envelope, null, 2);
  }
};

const formatNdjson = <T>(envelope: PinEnvelope<T>): string => {
  if (!envelope.ok || !envelope.data) {
    return JSON.stringify(envelope);
  }

  if (Array.isArray(envelope.data)) {
    return envelope.data.map((item) => JSON.stringify(item)).join("\n");
  }

  return JSON.stringify(envelope.data);
};

const formatPretty = <T>(envelope: PinEnvelope<T>): string => {
  const lines: string[] = [];

  if (!envelope.ok && envelope.error) {
    lines.push(`ERROR [${envelope.error.code}]: ${envelope.error.message}`);
    if (envelope.error.hint) {
      lines.push(`  hint: ${envelope.error.hint}`);
    }
    return lines.join("\n");
  }

  if (envelope.data && typeof envelope.data === "object") {
    if (Array.isArray(envelope.data)) {
      lines.push(`${envelope.meta.domain} ${envelope.meta.command}: ${envelope.data.length} item(s)`);
      for (const item of envelope.data) {
        lines.push(`  - ${JSON.stringify(item)}`);
      }
    } else {
      lines.push(`${envelope.meta.domain} ${envelope.meta.command}:`);
      for (const [key, value] of Object.entries(envelope.data as Record<string, unknown>)) {
        lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
    }
  }

  if (envelope._notice) {
    lines.push("");
    for (const [key, notice] of Object.entries(envelope._notice)) {
      lines.push(`[notice:${key}] ${notice.message}`);
      if (notice.hint) lines.push(`  hint: ${notice.hint}`);
    }
  }

  return lines.join("\n");
};
