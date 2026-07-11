import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionPanel } from "./SubscriptionPanel";

const coreMocks = vi.hoisted(() => ({
  cancelCurrentSubscription: vi.fn(),
  createCheckout: vi.fn(),
  createTopup: vi.fn(),
  getCurrentSubscription: vi.fn(),
  getCustomerPortalUrl: vi.fn(),
  getUsage: vi.fn(),
  listPaymentHistory: vi.fn(),
  listPaymentMethods: vi.fn(),
  reconcileSubscription: vi.fn(),
}));

vi.mock("@pin-ai/core", () => ({
  cancelCurrentSubscription: coreMocks.cancelCurrentSubscription,
  createCheckout: coreMocks.createCheckout,
  createTopup: coreMocks.createTopup,
  getCurrentSubscription: coreMocks.getCurrentSubscription,
  getCustomerPortalUrl: coreMocks.getCustomerPortalUrl,
  getUsage: coreMocks.getUsage,
  listPaymentHistory: coreMocks.listPaymentHistory,
  listPaymentMethods: coreMocks.listPaymentMethods,
  reconcileSubscription: coreMocks.reconcileSubscription,
}));

describe("SubscriptionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.reconcileSubscription.mockResolvedValue({ synced: true });
    coreMocks.getCurrentSubscription.mockResolvedValue({
      status: "active",
      planCode: "pro",
      pendingPlanCode: null,
      accessGranted: true,
      currentPeriodStart: "2026-06-01T00:00:00Z",
      currentPeriodEnd: "2026-07-01T00:00:00Z",
      cancelAtPeriodEnd: false,
    });
    coreMocks.listPaymentMethods.mockResolvedValue([]);
    coreMocks.listPaymentHistory.mockResolvedValue([]);
    coreMocks.getUsage.mockResolvedValue(null);
  });

  it("does not block subscription loading on slow Stripe reconcile", async () => {
    coreMocks.reconcileSubscription.mockReturnValue(new Promise(() => {}));

    render(<SubscriptionPanel onBack={vi.fn()} />);

    expect(screen.getByText("Loading subscription…")).toBeTruthy();
    await waitFor(
      () => expect(screen.queryByText("Loading subscription…")).toBeNull(),
      { timeout: 2500 },
    );
    expect(screen.getByText("Pro")).toBeTruthy();
  });

  it("keeps plan picker and credits top-up mutually exclusive", async () => {
    render(<SubscriptionPanel onBack={vi.fn()} />);

    const changePlan = await screen.findByText("Change plan");
    fireEvent.click(changePlan.closest("button")!);

    expect(screen.getByText("Hide")).toBeTruthy();
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.queryByText("Add credits (one-time)")).toBeNull();

    const addCredits = screen.getByText("Add credits");
    fireEvent.click(addCredits.closest("button")!);

    expect(screen.getByText("Add credits (one-time)")).toBeTruthy();
    expect(screen.queryByText("Basic")).toBeNull();
  });

  it("separates monthly plan credits from purchased extra credits", async () => {
    coreMocks.getCurrentSubscription.mockResolvedValue({
      status: "active",
      planCode: "free",
      pendingPlanCode: null,
      accessGranted: true,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    coreMocks.getUsage.mockResolvedValue({
      spendUsd: 0,
      maxBudgetUsd: 175,
      planAllowanceCredits: 10000,
      topupCreditsAvailable: 7500,
      budgetResetAt: null,
      budgetDuration: null,
    });

    render(<SubscriptionPanel onBack={vi.fn()} />);

    expect(
      await screen.findByText("$100 / month budget · 7,500 extra credits"),
    ).toBeTruthy();
    expect(screen.getByText("Plan credits")).toBeTruthy();
    expect(screen.getByText("0 / 10,000 credits")).toBeTruthy();
    expect(screen.getByText("(0%)")).toBeTruthy();
    expect(screen.getByText("Extra credits")).toBeTruthy();
    expect(screen.getByText("7,500 available")).toBeTruthy();
    expect(screen.getByText("Used after plan credits")).toBeTruthy();
    expect(screen.queryByText("0 / 500 credits")).toBeNull();
  });
});
