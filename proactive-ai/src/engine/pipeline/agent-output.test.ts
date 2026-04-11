import { describe, expect, it } from "vitest";
import { parseAgentJsonOrThrow } from "./agent-output.js";

describe("parseAgentJsonOrThrow", () => {
  it("parses JSON wrapped in a markdown code fence", () => {
    const result = parseAgentJsonOrThrow<{ ok: boolean }>(
      '```json\n{"ok":true}\n```',
      "plan:1",
    );

    expect(result).toEqual({ ok: true });
  });

  it("parses fenced JSON even when the model adds a leading explanation", () => {
    const result = parseAgentJsonOrThrow<{ ok: boolean }>(
      'Now I have enough context. Let me synthesize the plan:\n```json\n{"ok":true}\n```',
      "plan:1",
    );

    expect(result).toEqual({ ok: true });
  });

  it("parses a complete JSON object from an unclosed json fence", () => {
    const result = parseAgentJsonOrThrow<{ ok: boolean }>(
      'Now I have enough context. Let me synthesize the plan:\n```json\n{"ok":true}',
      "plan:1",
    );

    expect(result).toEqual({ ok: true });
  });

  it("surfaces raw provider errors instead of silently returning null", () => {
    expect(() =>
      parseAgentJsonOrThrow(
        "HTTP 403 forbidden: Request not allowed",
        "plan:1",
      ),
    ).toThrowError(/Agent plan:1 failed: HTTP 403 forbidden: Request not allowed/);
  });

  it("reports empty responses as upstream agent failures", () => {
    expect(() => parseAgentJsonOrThrow("", "plan:1")).toThrowError(
      /Agent plan:1 returned empty response/,
    );
  });
});
