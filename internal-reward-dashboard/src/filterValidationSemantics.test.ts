import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("./routes/{CasebookView,PersonalDataView,RunsView}.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("filter validation semantics", () => {
  it("passes every text filter into its page-level validation before loading data", () => {
    expect(routeSources["./routes/RunsView.tsx"]).toContain("runsFilterError({ since, trigger, until })");
    expect(routeSources["./routes/CasebookView.tsx"]).toContain(
      "casebookFilterError({ basket, intent, maxScore, minEvaluatorGap, minScore, since, until })",
    );
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain(
      "personalDataFilterError({ query: normalizedQuery, since, until })",
    );
  });

  it("keeps text filter inputs aligned with the API length boundaries", () => {
    expect(routeSources["./routes/RunsView.tsx"]).toContain("maxLength={REWARD_TEXT_FILTER_MAX_LENGTH}");
    expect(routeSources["./routes/CasebookView.tsx"].match(/maxLength=\{REWARD_TEXT_FILTER_MAX_LENGTH\}/g)).toHaveLength(2);
    expect(routeSources["./routes/PersonalDataView.tsx"]).toContain("maxLength={PERSONAL_DATA_QUERY_MAX_LENGTH}");
  });
});
