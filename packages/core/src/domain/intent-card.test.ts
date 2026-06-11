import { describe, expect, test } from "vitest";

import {
  deriveSourceAppsFromCitations,
  normalizeIntentCard,
} from "./intent-card";

describe("normalizeIntentCard", () => {
  test("preserves backend intentKey for feedback fanout", () => {
    expect(
      normalizeIntentCard({
        id: "card-1",
        intentKey: "work:review-pr",
        goalBasket: "work",
        title: "Review PR",
        whyNow: "Waiting for review",
        primaryAction: { label: "Review", type: "confirm" },
      }).intentKey,
    ).toBe("work:review-pr");
  });

  test("preserves scheduled source provenance", () => {
    const card = normalizeIntentCard({
      id: "card-1",
      goalBasket: "work",
      title: "AI 新闻",
      whyNow: "今日 AI 要闻",
      primaryAction: { label: "查看", type: "confirm" },
      sourceKind: "scheduled",
      sourceLabel: "AI 新闻卡片",
    });
    expect(card.sourceKind).toBe("scheduled");
    expect(card.sourceLabel).toBe("AI 新闻卡片");
  });

  test("omits source provenance when the backend doesn't send it", () => {
    const card = normalizeIntentCard({
      id: "card-1",
      goalBasket: "work",
      title: "x",
      whyNow: "y",
      primaryAction: { label: "z", type: "confirm" },
    });
    expect(card.sourceKind).toBeUndefined();
    expect(card.sourceLabel).toBeUndefined();
  });
});

describe("deriveSourceAppsFromCitations", () => {
  test("maps citation prefixes to app slugs, deduped in order", () => {
    expect(
      deriveSourceAppsFromCitations([
        "world id=w1, title=a",
        "gmail message id=m1, subject=b",
        "world id=w2, title=c",
        "signal id=sig_1, title=d",
      ]),
    ).toEqual(["web", "gmail", "device"]);
  });

  test("passes unknown connected_raw types through and drops garbage", () => {
    expect(deriveSourceAppsFromCitations(["slack id=m1, text=t"])).toEqual(["slack"]);
    expect(deriveSourceAppsFromCitations(["scheduled-reminder"])).toEqual([]);
    expect(deriveSourceAppsFromCitations([])).toEqual([]);
  });
});

describe("normalizeIntentCard sourceApps / reasoningSteps", () => {
  const base = {
    id: "c1",
    goalBasket: "work",
    title: "t",
    whyNow: "w",
    summary: "s",
    primaryAction: { label: "Do", type: "confirm" },
    sources: ["world id=w1, title=a"],
  };

  test("uses backend sourceApps when present", () => {
    const card = normalizeIntentCard({ ...base, sourceApps: ["gmail", "web"] });
    expect(card.sourceApps).toEqual(["gmail", "web"]);
  });

  test("derives sourceApps from citations for legacy cards", () => {
    const card = normalizeIntentCard(base);
    expect(card.sourceApps).toEqual(["web"]);
  });

  test("keeps well-formed reasoningSteps and drops malformed entries", () => {
    const card = normalizeIntentCard({
      ...base,
      reasoningSteps: [
        { label: "observed", detail: "saw it" },
        { label: "", detail: "no label" },
        { label: "decided", detail: "" },
        "not-a-record",
        { label: "decided", detail: "surfaced" },
      ],
    });
    expect(card.reasoningSteps).toEqual([
      { label: "observed", detail: "saw it" },
      { label: "decided", detail: "surfaced" },
    ]);
  });

  test("defaults reasoningSteps to [] for legacy cards", () => {
    expect(normalizeIntentCard(base).reasoningSteps).toEqual([]);
  });
});
