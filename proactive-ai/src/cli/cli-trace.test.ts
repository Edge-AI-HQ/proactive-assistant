import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { runCli } from "./cli.js";
import { getCliTracePath, getRunTracePath } from "../engine/pipeline/trace.js";

describe("runCli tracing", () => {
  it("records global and per-run trace entries with redacted input payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pin-cli-trace-"));

    try {
      const runtime = {
        env: {
          PIN_DATA_ROOT: root,
          PIN_TRACE_RUN_ID: "run_trace_cli",
          PIN_TRACE_CONTEXT: "planner:1",
        },
        homeDir: "/Users/test",
      };

      const result = await runCli([
        "personal",
        "exec",
        "--tool",
        "GMAIL_FETCH_EMAILS",
        "--input",
        "{\"query\":\"board prep\",\"token\":\"secret\"}",
        "--json",
      ], runtime);

      expect(result.stdout.meta.domain).toBe("personal");

      const globalTrace = await readFile(getCliTracePath(runtime), "utf8");
      const runTrace = await readFile(getRunTracePath(runtime, "run_trace_cli"), "utf8");

      expect(globalTrace).not.toContain("board prep");
      expect(globalTrace).not.toContain("secret");
      expect(globalTrace).toContain("\"kind\":\"pin_cli.invoke\"");
      expect(globalTrace).toContain("\"kind\":\"pin_cli.result\"");
      expect(globalTrace).toContain("\"traceContext\":\"planner:1\"");
      expect(runTrace).toContain("\"runId\":\"run_trace_cli\"");
      expect(runTrace).toContain("\"phase\":\"planner\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
