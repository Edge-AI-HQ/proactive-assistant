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

  it("repairs planner json when reasoning contains raw quoted phrases", () => {
    const result = parseAgentJsonOrThrow<{ reasoning: string; collectedContext: Record<string, unknown>; intentsToGenerate: unknown[] }>(
      `Now I have enough context to produce the plan.

\`\`\`json
{
  "reasoning": "今日为 2026-04-11（周六），亚洲/上海时区。这是第一次正式生成批次。此前用户打开了 3 张卡片但均未 confirm：growth 方向的"伊朗危机阅读清单"、wealth 方向的"通胀/能源敞口核查清单"、life 方向的"选定一个每日阅读摘要来源"。",
  "collectedContext": {},
  "intentsToGenerate": []
}
\`\`\``,
      "plan:1",
    );

    expect(result.reasoning).toContain('"伊朗危机阅读清单"');
  });

  it("repairs planner json when reasoning contains a raw quoted goal phrase", () => {
    const result = parseAgentJsonOrThrow<{ reasoning: string; collectedContext: Record<string, unknown>; intentsToGenerate: unknown[] }>(
      `\`\`\`json
{
  "reasoning": "最关键的实时信号：当前时间是周六凌晨 01:35（上海），用户正在运行主动 AI 系统——这与其高优先级目标"防止倦怠、保护个人时间"直接碰撞，是一个高置信度的倦怠预警信号。",
  "collectedContext": {},
  "intentsToGenerate": []
}
\`\`\``,
      "plan:1",
    );

    expect(result.reasoning).toContain('"防止倦怠、保护个人时间"');
  });

  it("repairs planner json when reasoning contains a raw quoted life-balance phrase", () => {
    const result = parseAgentJsonOrThrow<{ reasoning: string; collectedContext: Record<string, unknown>; intentsToGenerate: unknown[] }>(
      `Now I have enough context. Let me synthesize the plan:

\`\`\`json
{
  "reasoning": "用户在凌晨 1 点仍处于活跃状态，与其"保护个人时间、避免过劳"的高优先级目标存在明显偏差。",
  "collectedContext": {},
  "intentsToGenerate": []
}
\`\`\``,
      "plan:1",
    );

    expect(result.reasoning).toContain('"保护个人时间、避免过劳"');
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
