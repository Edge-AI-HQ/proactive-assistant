// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { CoreContext } from "../../core/context.js";
import * as profileService from "../../core/domains/profile/service.js";
import {
  applyConnectorHistoryBatches,
  applyProfileIngestPatch,
  runProfileIngestAgent,
  splitProfileIngestPayload,
} from "./agent.js";

vi.mock("../../core/domains/profile/service.js", () => ({
  setFact: vi.fn(async () => ({})),
  setPreference: vi.fn(async () => ({})),
  addMemory: vi.fn(async () => ({ id: "mem-mock-1" })),
  appendConnectorRawData: vi.fn(async () => ({ id: "raw-mock-1" })),
  updateProfile: vi.fn(async () => ({})),
}));

const testCtx: CoreContext = {
  env: {},
  homeDir: "/tmp/proactive-ai-profile-ingest-test",
};

describe("runProfileIngestAgent", () => {
  it("parses profile patch JSON from subagent assistant message", async () => {
    const assistantPayload = JSON.stringify({
      evidence_summary: "mock: ran pin flow",
      facts_delta: { "ingest.probe": "from-test" },
      preferences_delta: {},
      memory_candidates: [],
    });

    const api = {
      runtime: {
        subagent: {
          run: vi.fn().mockResolvedValue({ runId: "run_profile_ingest_1" }),
          waitForRun: vi.fn().mockResolvedValue({ status: "ok" as const }),
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [
              { role: "user", content: "Run ingest" },
              { role: "assistant", content: assistantPayload },
            ],
          }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as OpenClawPluginApi;

    const out = await runProfileIngestAgent(api, {
      toolkit: null,
      maxRecords: 25,
      persistToProfile: true,
    });

    expect(api.runtime.subagent.run).toHaveBeenCalled();
    expect(out.subagentCompleted).toBe(true);
    expect(out.historyBatches).toEqual([]);
    expect(out.patch?.evidence_summary).toContain("mock");
    expect(out.patch?.facts_delta?.["ingest.probe"]).toBe("from-test");
  });

  it("parses assistant JSON from block-style content", async () => {
    const assistantPayload = JSON.stringify({
      evidence_summary: "blocks",
      facts_delta: { a: 1 },
    });

    const api = {
      runtime: {
        subagent: {
          run: vi.fn().mockResolvedValue({ runId: "r2" }),
          waitForRun: vi.fn().mockResolvedValue({ status: "ok" as const }),
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: assistantPayload }],
              },
            ],
          }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as OpenClawPluginApi;

    const out = await runProfileIngestAgent(api, {
      toolkit: "gmail",
      maxRecords: 10,
      persistToProfile: true,
    });
    expect(out.subagentCompleted).toBe(true);
    expect(out.historyBatches).toEqual([]);
    expect(out.patch?.facts_delta?.a).toBe(1);
  });

  it("returns historyBatches without profile patch when only connector history is present", async () => {
    const assistantPayload = JSON.stringify({
      connector_history_batches: [
        {
          toolkit: "gmail",
          tool_slug: "GMAIL_MESSAGES_LIST",
          records_json: '{"items":[]}',
        },
      ],
    });

    const api = {
      runtime: {
        subagent: {
          run: vi.fn().mockResolvedValue({ runId: "r3" }),
          waitForRun: vi.fn().mockResolvedValue({ status: "ok" as const }),
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [{ role: "assistant", content: assistantPayload }],
          }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as OpenClawPluginApi;

    const out = await runProfileIngestAgent(api, {
      toolkit: "gmail",
      maxRecords: 5,
      persistToProfile: true,
    });
    expect(out.subagentCompleted).toBe(true);
    expect(out.patch).toBeNull();
    expect(out.historyBatches).toHaveLength(1);
    expect(out.historyBatches[0]?.toolkit).toBe("gmail");
    expect(out.historyBatches[0]?.records_json).toContain("items");
  });

  it("sets subagentCompleted when assistant message is not JSON", async () => {
    const api = {
      runtime: {
        subagent: {
          run: vi.fn().mockResolvedValue({ runId: "r-plain" }),
          waitForRun: vi.fn().mockResolvedValue({ status: "ok" as const }),
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [
              { role: "assistant", content: "done — persisted via pin CLI" },
            ],
          }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as OpenClawPluginApi;

    const out = await runProfileIngestAgent(api, {
      toolkit: null,
      maxRecords: 10,
      persistToProfile: true,
    });
    expect(out.subagentCompleted).toBe(true);
    expect(out.patch).toBeNull();
    expect(out.historyBatches).toEqual([]);
  });

  it("throws when subagent runtime is missing", async () => {
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    await expect(
      runProfileIngestAgent(api, {
        toolkit: null,
        maxRecords: 10,
        persistToProfile: true,
      }),
    ).rejects.toThrow(/subagent/i);
  });
});

describe("splitProfileIngestPayload", () => {
  it("splits connector_history_batches from profile fields", () => {
    const { historyBatches, patch } = splitProfileIngestPayload({
      connector_history_batches: [
        {
          toolkit: "slack",
          connected_account_id: "ca_abc",
          records_json: "{}",
        },
      ],
      facts_delta: { a: 1 },
    });
    expect(historyBatches).toHaveLength(1);
    expect(historyBatches[0]?.connected_account_id).toBe("ca_abc");
    expect(patch.facts_delta?.a).toBe(1);
    expect(
      (patch as { connector_history_batches?: unknown })
        .connector_history_batches,
    ).toBeUndefined();
  });
});

describe("applyConnectorHistoryBatches", () => {
  beforeEach(() => {
    vi.mocked(profileService.appendConnectorRawData).mockClear();
  });

  it("stores each batch via appendConnectorRawData (connector_raw_data)", async () => {
    vi.mocked(profileService.appendConnectorRawData)
      .mockResolvedValueOnce({ id: "h1" })
      .mockResolvedValueOnce({ id: "h2" });

    const out = await applyConnectorHistoryBatches(testCtx, [
      {
        toolkit: "gmail",
        tool_slug: "GMAIL_LIST",
        window_label: "7d",
        records_json: '{"x":1}',
      },
      { toolkit: "slack", records_json: "{}" },
    ]);

    expect(out.storedRawDataIds).toEqual(["h1", "h2"]);
    expect(
      vi.mocked(profileService.appendConnectorRawData),
    ).toHaveBeenCalledTimes(2);
    const first = vi.mocked(profileService.appendConnectorRawData).mock
      .calls[0]?.[1];
    expect(first?.toolkit).toBe("gmail");
    expect(first?.toolSlug).toBe("GMAIL_LIST");
    expect(first?.windowLabel).toBe("7d");
    expect(first?.payloadJson).toContain('"x"');
    expect(first?.ingestSource).toBe("profile_ingest");
  });
});

describe("applyProfileIngestPatch (connector ingest → profile DB)", () => {
  beforeEach(() => {
    vi.mocked(profileService.setFact).mockClear();
    vi.mocked(profileService.setPreference).mockClear();
    vi.mocked(profileService.addMemory).mockClear();
    vi.mocked(profileService.updateProfile).mockClear();
  });

  it("calls setFact / setPreference / addMemory / updateProfile with expected payloads", async () => {
    vi.mocked(profileService.addMemory).mockResolvedValueOnce({
      id: "mem-uuid-1",
      kind: "connector_ingest",
      text: "hello",
    });

    const applied = await applyProfileIngestPatch(testCtx, {
      evidence_summary: "connector gmail",
      facts_delta: {
        "connector.gmail.last_sync": "2026-04-16",
        "": "ignored-empty-key",
      },
      preferences_delta: { "ui.theme": "dark" },
      memory_candidates: [
        {
          kind: "connector_ingest",
          text: "  thread summary  ",
          tags: ["gmail"],
        },
        { text: "" },
        { text: "   " },
      ],
      profile_summary_update: "  one line summary  ",
    });

    expect(vi.mocked(profileService.setFact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(profileService.setFact)).toHaveBeenCalledWith(testCtx, {
      key: "connector.gmail.last_sync",
      valueJson: JSON.stringify("2026-04-16"),
    });

    expect(vi.mocked(profileService.setPreference)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(profileService.setPreference)).toHaveBeenCalledWith(
      testCtx,
      {
        key: "ui.theme",
        valueJson: JSON.stringify("dark"),
      },
    );

    expect(vi.mocked(profileService.addMemory)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(profileService.addMemory)).toHaveBeenCalledWith(
      testCtx,
      expect.objectContaining({
        kind: "connector_ingest",
        text: "thread summary",
        tagsJson: JSON.stringify(["gmail"]),
      }),
    );

    expect(vi.mocked(profileService.updateProfile)).toHaveBeenCalledWith(
      testCtx,
      { id: "default", summary: "one line summary" },
    );

    expect(applied).toEqual({
      appliedFacts: ["connector.gmail.last_sync"],
      appliedPreferences: ["ui.theme"],
      memoryIds: ["mem-uuid-1"],
      summaryUpdated: true,
    });
  });

  it("does not push memory id when addMemory returns no string id", async () => {
    vi.mocked(profileService.addMemory).mockResolvedValueOnce({
      kind: "connector_ingest",
      text: "x",
    });

    const applied = await applyProfileIngestPatch(testCtx, {
      memory_candidates: [{ text: "note" }],
    });

    expect(applied.memoryIds).toEqual([]);
  });

  it("rejects patches with too many delta keys", async () => {
    const facts_delta: Record<string, unknown> = {};
    for (let i = 0; i < 33; i += 1) facts_delta[`k${i}`] = i;

    await expect(
      applyProfileIngestPatch(testCtx, { facts_delta }),
    ).rejects.toThrow(/max 32 keys/i);
    expect(vi.mocked(profileService.setFact)).not.toHaveBeenCalled();
  });
});
