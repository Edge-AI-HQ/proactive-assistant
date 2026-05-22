import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import AmbientSummaryModePanel from "./AmbientSummaryModePanel";
import {
  AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY,
  loadAmbientSummaryPreference,
} from "@/services/ambient/summary-preference";

describe("AmbientSummaryModePanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("lets users choose local-only summaries", () => {
    render(<AmbientSummaryModePanel runtimeStatus={{ uploadsLocked: false }} />);

    fireEvent.click(screen.getByRole("button", { name: /Local only/i }));

    expect(loadAmbientSummaryPreference()).toBe("local_only");
    expect(localStorage.getItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY)).toBe("local_only");
    expect(screen.getByText("Local active")).toBeTruthy();
  });

  test("shows upload lock enforcement for cloud preference", () => {
    localStorage.setItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY, "cloud_when_unlocked");

    render(<AmbientSummaryModePanel runtimeStatus={{ uploadsLocked: true }} />);

    expect(screen.getByText("Local enforced")).toBeTruthy();
    expect(screen.getByText(/Cloud summaries are paused/i)).toBeTruthy();
    expect(screen.getByText("After unlock")).toBeTruthy();
  });
});
