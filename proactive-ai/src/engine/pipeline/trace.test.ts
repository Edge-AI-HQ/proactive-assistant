import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  appendRunTraceEvent,
  getCliTracePath,
  getRunTracePath,
  parseGatewayAnomalyLines,
  redactCliArgv,
} from "./trace.js";

describe("pipeline trace helpers", () => {
  it("redacts personal exec input payloads and secrets", () => {
    const redacted = redactCliArgv([
      "personal",
      "exec",
      "--tool",
      "GMAIL_FETCH_EMAILS",
      "--input",
      "{\"query\":\"board prep\",\"apiKey\":\"secret-123\",\"nested\":{\"token\":\"abc\"}}",
      "--token",
      "top-secret",
      "--json",
    ]);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("board prep");
    expect(serialized).not.toContain("secret-123");
    expect(serialized).not.toContain("top-secret");
    expect(redacted.command).toBe("personal exec");
    expect(redacted.argvRedacted).toEqual(expect.arrayContaining([
      "--tool",
      "GMAIL_FETCH_EMAILS",
    ]));
    expect(serialized).toContain("\"keys\":[\"apiKey\",\"nested\",\"query\"]");
    expect(serialized).toContain("\"hash\":");
  });

  it("writes NDJSON events into the per-run trace artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pin-trace-"));

    try {
      await appendRunTraceEvent(
        {
          homeDir: "/Users/test",
          env: { PIN_DATA_ROOT: root },
        },
        "run_abc",
        {
          timestamp: "2026-04-09T10:00:00.000Z",
          iteration: 1,
          phase: "planner",
          kind: "agent.prompt_stats",
          name: "planner:1",
          durationMs: 12,
          attrs: { chars: 512 },
        },
      );

      const tracePath = getRunTracePath({
        homeDir: "/Users/test",
        env: { PIN_DATA_ROOT: root },
      }, "run_abc");
      const content = await readFile(tracePath, "utf8");

      expect(tracePath).toContain("proactive-ai/traces/run_abc.ndjson");
      expect(content).toContain("\"runId\":\"run_abc\"");
      expect(content).toContain("\"kind\":\"agent.prompt_stats\"");
      expect(content).toContain("\"chars\":512");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts gateway anomalies inside the run window", () => {
    const events = parseGatewayAnomalyLines(
      [
        "{\"1\":\"read tool called without path: toolCallId=toolu_1 argsType=object\",\"_meta\":{\"logLevelName\":\"WARN\"},\"time\":\"2026-04-09T14:05:44.149+08:00\"}",
        "{\"1\":\"web_search failed: timeout\",\"_meta\":{\"logLevelName\":\"ERROR\"},\"time\":\"2026-04-09T14:05:54.149+08:00\"}",
        "{\"1\":\"normal info\",\"_meta\":{\"logLevelName\":\"INFO\"},\"time\":\"2026-04-09T14:04:54.149+08:00\"}",
      ],
      {
        runId: "run_abc",
        startedAt: "2026-04-09T14:05:00.000+08:00",
        endedAt: "2026-04-09T14:06:00.000+08:00",
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("gateway.anomaly");
    expect(events[0]?.attrs?.message).toContain("read tool called without path");
    expect(events[1]?.attrs?.message).toContain("web_search failed");
  });

  it("derives global cli trace path under the proactive-ai root", () => {
    const tracePath = getCliTracePath({
      homeDir: "/Users/test",
      env: { PIN_DATA_ROOT: "/tmp/pin-data-root" },
    });

    expect(tracePath).toBe("/tmp/pin-data-root/proactive-ai/cli-trace.ndjson");
  });
});
