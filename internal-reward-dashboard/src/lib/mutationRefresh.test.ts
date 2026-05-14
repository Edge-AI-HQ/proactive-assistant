import { describe, expect, it } from "vitest";
import { staleMutationRefreshError, staleMutationRefreshMessage } from "./mutationRefresh";

describe("mutation refresh helpers", () => {
  it("uses a readable error for superseded post-mutation refreshes", () => {
    expect(staleMutationRefreshError().message).toBe(staleMutationRefreshMessage);
  });
});
