import { describe, expect, test } from "vitest";

import { describeApproval, humanizeSlug } from "./hitl-approval";

describe("humanizeSlug", () => {
  test("upper/snake-case slug → sentence case", () => {
    expect(humanizeSlug("GMAIL_SEND_DRAFT")).toBe("Gmail send draft");
  });
});

describe("describeApproval — COMPOSIO_MULTI_EXECUTE_TOOL", () => {
  const multi = (calls: unknown[]) =>
    describeApproval(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      { calls },
      JSON.stringify({ calls }),
    );

  test("single call (prompted tool_slug key) → humanized title, no raw JSON", () => {
    const { title, detail } = multi([{ tool_slug: "GMAIL_SEND_DRAFT", arguments: {} }]);
    expect(title).toBe("Gmail send draft");
    expect(detail).toBeUndefined();
  });

  // The model frequently shortens the prompted `tool_slug` to `slug` — the exact
  // shape from the bug report (raw JSON leaked to the user). Must humanize.
  test("single call (slug shorthand) → humanized title, not raw JSON", () => {
    const { title } = multi([{ slug: "GMAIL_SEND_DRAFT", args: {} }]);
    expect(title).toBe("Gmail send draft");
  });

  test("name key also accepted", () => {
    expect(multi([{ name: "SLACK_SEND_MESSAGE" }]).title).toBe("Slack send message");
  });

  test("multiple calls (slug shorthand) → 'Run N actions' + humanized bullets", () => {
    const { title, detail } = multi([
      { slug: "GITHUB_LIST_REPOSITORY_WORKFLOWS" },
      { slug: "GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY" },
    ]);
    expect(title).toBe("Run 2 actions");
    expect(detail).toBe(
      "• Github list repository workflows\n• Github list workflow runs for a repository",
    );
  });

  test("unrecognizable call keys → 'Run an action' fallback", () => {
    expect(
      describeApproval("COMPOSIO_MULTI_EXECUTE_TOOL", { calls: [{ foo: "bar" }] }, "{raw}").title,
    ).toBe("Run an action");
  });
});

describe("describeApproval — other tools", () => {
  test("preference_add shows the user's statement verbatim", () => {
    const { title, detail } = describeApproval(
      "preference_add",
      { statement: "I prefer morning meetings", scope: "work" },
      "{raw}",
    );
    expect(title).toBe("Save a preference");
    expect(detail).toBe("I prefer morning meetings");
  });

  test("unknown future tool → humanized name", () => {
    expect(describeApproval("SOME_FUTURE_TOOL", {}, undefined).title).toBe("Some future tool");
  });
});
