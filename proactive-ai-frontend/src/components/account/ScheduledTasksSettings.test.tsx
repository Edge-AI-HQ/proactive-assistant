import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ScheduledGeneratorTask } from "@/lib/api";

const apiMock = vi.hoisted(() => ({
  listScheduledGenerators: vi.fn(),
  pauseScheduledGenerator: vi.fn(),
  resumeScheduledGenerator: vi.fn(),
  deleteScheduledGenerator: vi.fn(),
}));

vi.mock("@/lib/api", () => apiMock);

function makeTask(overrides: Partial<ScheduledGeneratorTask> = {}): ScheduledGeneratorTask {
  return {
    id: "task_1",
    kind: "generator.scheduled",
    status: "active",
    title: "AI 新闻",
    frequency: "daily",
    localTime: "09:00",
    timezone: "America/Los_Angeles",
    cronExpr: "0 9 * * *",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    payload: {},
    ...overrides,
  };
}

describe("ScheduledTasksSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders tasks with schedule and status", async () => {
    apiMock.listScheduledGenerators.mockResolvedValue([makeTask()]);
    const { default: ScheduledTasksSettings } = await import(
      "@/components/account/ScheduledTasksSettings"
    );
    render(<ScheduledTasksSettings />);

    expect(await screen.findByText("AI 新闻")).toBeTruthy();
    expect(screen.getByText("daily · 09:00 · America/Los_Angeles")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  test("shows empty state when there are no tasks", async () => {
    apiMock.listScheduledGenerators.mockResolvedValue([]);
    const { default: ScheduledTasksSettings } = await import(
      "@/components/account/ScheduledTasksSettings"
    );
    render(<ScheduledTasksSettings />);

    expect(await screen.findByText(/No scheduled tasks yet/i)).toBeTruthy();
  });

  test("toggling an active task pauses it", async () => {
    apiMock.listScheduledGenerators.mockResolvedValue([makeTask()]);
    apiMock.pauseScheduledGenerator.mockResolvedValue(makeTask({ status: "paused" }));
    const { default: ScheduledTasksSettings } = await import(
      "@/components/account/ScheduledTasksSettings"
    );
    render(<ScheduledTasksSettings />);

    fireEvent.click(await screen.findByRole("switch"));

    await waitFor(() => {
      expect(apiMock.pauseScheduledGenerator).toHaveBeenCalledWith("task_1");
      expect(screen.getByText("paused")).toBeTruthy();
    });
  });

  test("deleting a task removes it from the list", async () => {
    apiMock.listScheduledGenerators.mockResolvedValue([makeTask()]);
    apiMock.deleteScheduledGenerator.mockResolvedValue(makeTask({ status: "archived" }));
    const { default: ScheduledTasksSettings } = await import(
      "@/components/account/ScheduledTasksSettings"
    );
    render(<ScheduledTasksSettings />);

    await screen.findByText("AI 新闻");
    fireEvent.click(screen.getByRole("button", { name: /Delete/i }));

    await waitFor(() => {
      expect(apiMock.deleteScheduledGenerator).toHaveBeenCalledWith("task_1");
      expect(screen.queryByText("AI 新闻")).toBeNull();
    });
  });
});
