import type { IntentCard } from "../../core/index.js";
import type { IntentEvidencePack } from "./evidence-builder.js";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "warning" | "error";
}

export interface ValidationResult {
  cardId: string;
  issues: ValidationIssue[];
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasSpecificWhyNow(value: string): boolean {
  return /\b(today|tomorrow|tonight|this week|this month|q[1-4]|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}(?::\d{2})?|\d{4}-\d{2}-\d{2})\b/i.test(value);
}

function buildEvidenceLookup(packs: Record<string, Pick<IntentEvidencePack, "evidenceRefs" | "facts" | "objective">>): Record<string, Set<string>> {
  const lookup: Record<string, Set<string>> = {};
  for (const [cardId, pack] of Object.entries(packs)) {
    lookup[cardId] = new Set(pack.evidenceRefs ?? []);
  }
  return lookup;
}

export function runRuleValidators(
  cards: IntentCard[],
  packsByCardId: Record<string, Pick<IntentEvidencePack, "evidenceRefs" | "facts" | "objective">>,
): Record<string, ValidationResult> {
  const duplicates = new Map<string, string[]>();
  for (const card of cards) {
    const normalized = normalizeTitle(card.title);
    duplicates.set(normalized, [...(duplicates.get(normalized) ?? []), card.id]);
  }

  const evidenceLookup = buildEvidenceLookup(packsByCardId);
  const results: Record<string, ValidationResult> = {};

  for (const card of cards) {
    const issues: ValidationIssue[] = [];

    if (!card.sources?.length) {
      issues.push({
        code: "sources.missing",
        message: "Card does not cite any evidence sources.",
        severity: "error",
      });
    }

    if (!hasSpecificWhyNow(card.whyNow)) {
      issues.push({
        code: "why_now.weak",
        message: "Why-now rationale lacks a concrete date, time, or trigger.",
        severity: "warning",
      });
    }

    const duplicatesForTitle = duplicates.get(normalizeTitle(card.title)) ?? [];
    if (duplicatesForTitle.length > 1) {
      issues.push({
        code: "card.duplicate_title",
        message: "Another card in this batch has a materially identical title.",
        severity: "warning",
      });
    }

    const allowedRefs = evidenceLookup[card.id];
    if (allowedRefs && card.sources?.length) {
      const mismatchedSources = card.sources.filter((source) => !allowedRefs.has(source));
      if (mismatchedSources.length === card.sources.length) {
        issues.push({
          code: "sources.unmapped",
          message: "Card sources do not align with the assigned evidence pack.",
          severity: "warning",
        });
      }
    }

    results[card.id] = { cardId: card.id, issues };
  }

  return results;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current]!, current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()),
  );

  return results;
}
