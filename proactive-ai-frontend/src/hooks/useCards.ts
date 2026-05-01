/**
 * Cross-run card history for ChatTimeline + NOW view.
 *
 * Backs the `GET /cards` endpoint (see plugins/proactive-ai/routes/runs.ts).
 * The pre-existing `/runs` endpoint only returns the latest completed run,
 * which made every new generation appear to "kick out" prior cards from the
 * frontend even though the database always kept them. This hook is the
 * single read path for the full history.
 *
 * Refresh strategy:
 *   - On mount.
 *   - On tab visibility change (so a backgrounded tab catches up the moment
 *     it returns).
 *   - On a 30s interval (kept aligned with the previous ChatTimeline polling
 *     cadence so we don't quietly raise traffic).
 *   - On explicit refresh() (callers wire this to "generate just finished").
 *
 * No internal dedup. Each consumer decides:
 *   - ChatTimeline shows every entry as a history row.
 *   - NOW view dedups by intentKey so the same intent regenerated across
 *     runs only floats once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { proxyFetch } from "@/lib/api";
import {
  normalizeIntentCard,
  type IntentCard,
} from "@/types/intent-card";

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 200;

export interface CardScore {
  overall: number;
  pass: boolean;
}

export interface VisibleCardEntry {
  card: IntentCard;
  runId: string;
  runCompletedAt: string;
  score: CardScore | null;
}

export interface UseCardsState {
  loading: boolean;
  cards: VisibleCardEntry[];
  error: string | null;
}

interface CardsResponseEntry {
  card?: unknown;
  runId?: unknown;
  runCompletedAt?: unknown;
  score?: unknown;
}

function parseScore(value: unknown): CardScore | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.overall !== "number" || typeof r.pass !== "boolean") return null;
  return { overall: r.overall, pass: r.pass };
}

function parseEntries(payload: unknown): VisibleCardEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as { cards?: unknown }).cards;
  if (!Array.isArray(list)) return [];
  const out: VisibleCardEntry[] = [];
  for (const raw of list as CardsResponseEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.runId !== "string" || typeof raw.runCompletedAt !== "string") continue;
    out.push({
      card: normalizeIntentCard(raw.card),
      runId: raw.runId,
      runCompletedAt: raw.runCompletedAt,
      score: parseScore(raw.score),
    });
  }
  return out;
}

export function useCards(opts?: { limit?: number }): UseCardsState & {
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<UseCardsState>({
    loading: true,
    cards: [],
    error: null,
  });
  const inFlightRef = useRef(false);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await proxyFetch(`/cards?limit=${encodeURIComponent(limit)}`, { signal });
        if (signal?.aborted) return;
        if (!res.ok) {
          setState((prev) => ({ ...prev, loading: false, error: `HTTP ${res.status}` }));
          return;
        }
        const data = await res.json();
        if (signal?.aborted) return;
        setState({ loading: false, cards: parseEntries(data), error: null });
      } catch (err) {
        if (signal?.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't blank out previously-loaded cards on a transient error.
        setState((prev) => ({ ...prev, loading: false, error: msg }));
      } finally {
        inFlightRef.current = false;
      }
    },
    [limit],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(controller.signal);
    }, POLL_INTERVAL_MS);

    function onVisibility() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load(controller.signal);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  return { ...state, refresh };
}
