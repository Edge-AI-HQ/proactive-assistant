// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreContext } from "../../core/context.js";
import * as personal from "../../core/domains/personal/service.js";
import { createPersonalProvider } from "../../core/domains/personal/provider.js";
import * as profileService from "../../core/domains/profile/service.js";
import { hostConnectorIngestPersist } from "./host-persist.js";

vi.mock("../../core/domains/personal/service.js", () => ({
  listConnections: vi.fn(),
}));

vi.mock("../../core/domains/personal/provider.js", () => ({
  createPersonalProvider: vi.fn(),
}));

vi.mock("../../core/domains/profile/service.js", () => ({
  appendConnectorRawData: vi.fn(async () => ({ id: "raw-host-1" })),
  setFact: vi.fn(async () => ({})),
}));

const ctx: CoreContext = { env: {}, homeDir: "/tmp/host-persist-test" };

describe("hostConnectorIngestPersist", () => {
  beforeEach(() => {
    vi.mocked(personal.listConnections).mockReset();
    vi.mocked(createPersonalProvider).mockReset();
    vi.mocked(profileService.appendConnectorRawData).mockClear();
    vi.mocked(profileService.setFact).mockClear();
  });

  it("returns skipped when no active connection", async () => {
    vi.mocked(personal.listConnections).mockResolvedValueOnce([
      {
        toolkit: "gmail",
        status: "PENDING",
        connectedAccountId: "ca_x",
        userInfo: null,
        redirectUrl: null,
      },
    ]);
    const out = await hostConnectorIngestPersist(ctx, {
      toolkit: "gmail",
      maxRecords: 5,
    });
    expect(out.skipped).toBe("no_active_connection");
    expect(out.rawDataIds).toHaveLength(0);
    expect(
      vi.mocked(profileService.appendConnectorRawData),
    ).not.toHaveBeenCalled();
  });

  it("writes connector_raw_data and facts when identity resolves", async () => {
    vi.mocked(personal.listConnections).mockResolvedValueOnce([
      {
        toolkit: "gmail",
        status: "ACTIVE",
        connectedAccountId: "ca_abc",
        userInfo: null,
        redirectUrl: null,
      },
    ]);
    vi.mocked(createPersonalProvider).mockReturnValue({
      resolveAccountIdentity: vi.fn(async () => ({
        email: "u@example.com",
        displayName: "User One",
      })),
    } as unknown as ReturnType<typeof createPersonalProvider>);

    const out = await hostConnectorIngestPersist(ctx, {
      toolkit: "gmail",
      maxRecords: 10,
    });

    expect(out.skipped).toBeUndefined();
    expect(out.rawDataIds).toEqual(["raw-host-1"]);
    expect(
      vi.mocked(profileService.appendConnectorRawData),
    ).toHaveBeenCalledTimes(1);
    const appendArg = vi.mocked(profileService.appendConnectorRawData).mock
      .calls[0]?.[1];
    expect(appendArg?.ingestSource).toBe("host_connector_ingest");
    expect(appendArg?.payloadJson).toContain("host_identity_snapshot_v1");
    expect(vi.mocked(profileService.setFact).mock.calls.length).toBeGreaterThan(
      0,
    );
  });
});
