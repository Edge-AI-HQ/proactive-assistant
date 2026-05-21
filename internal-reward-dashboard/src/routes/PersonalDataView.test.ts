import { describe, expect, it } from "vitest";
import {
  canCopyPersonalDataView,
  overviewSummaryText,
  personalDataBlockingError,
  personalDataCopyUnavailableMessage,
  personalDataEmptyStateTitle,
  personalDataFilterError,
  personalDataDisplayPayload,
  personalDataHideStaleOverview,
  personalDataHideStaleRows,
  personalDataItem,
  personalDataMarkdown,
  personalDataNoSectionsMessage,
  personalDataRefreshErrorText,
  personalDataResponse,
  personalDataSections,
} from "./PersonalDataView";
import { PERSONAL_DATA_QUERY_MAX_LENGTH } from "@/api/reward";
import type { PersonalDataResponse } from "@/api/reward";

function personalData(): PersonalDataResponse {
  return {
    ok: true,
    filters: {
      category: "memory",
      since: null,
      until: null,
      query: null,
      limit: 40,
      offset: 0,
    },
    totals: { all: 1, memory: 1 },
    sections: [{
      key: "memory",
      label: "记忆",
      description: "长期事实",
      total: 1,
      items: [{
        id: "memory_1",
        category: "memory",
        sourceKey: "pai_memories",
        sourceLabel: "Memory",
        kind: "preference",
        title: "Prefer concise review notes",
        subtitle: "workflow",
        summary: "User prefers direct review notes with evidence.",
        status: "active",
        score: 0.87,
        occurredAt: "2026-05-14T10:00:00.000Z",
        updatedAt: "2026-05-14T10:05:00.000Z",
        chips: ["review", "preference"],
        payload: {
          confidence: 0.87,
          summary: "Direct evidence-backed review notes.",
          metadata: { hidden: true },
        },
      }],
    }],
  };
}

function manyPersonalDataItems(): PersonalDataResponse {
  return {
    ...personalData(),
    sections: [{
      ...personalData().sections[0],
      total: 13,
      items: Array.from({ length: 13 }, (_, index) => ({
        ...personalData().sections[0].items[0],
        id: `memory_${index + 1}`,
        title: `Memory ${index + 1}`,
        payload: Object.fromEntries(
          Array.from({ length: 6 }, (__, fieldIndex) => [`field_${fieldIndex + 1}`, `value ${fieldIndex + 1}`]),
        ),
      })),
    }],
  };
}

describe("personalDataMarkdown", () => {
  it("exports visible personal data context with filters and payload fields", () => {
    const markdown = personalDataMarkdown(personalData(), {
      categoryLabel: "记忆",
      query: "review",
      selectedTotal: 1,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("### 个人数据视图 记忆");
    expect(markdown).toContain("- 搜索: review");
    expect(markdown).toContain("#### 记忆 (1)");
    expect(markdown).toContain("1. Prefer concise review notes");
    expect(markdown).toContain("- 来源: Memory / preference");
    expect(markdown).toContain("- 状态/分数: active / 0.87");
    expect(markdown).toContain("- 标签: review, preference");
    expect(markdown).toContain("- 置信度: 0.87");
    expect(markdown).not.toContain("hidden");
  });

  it("returns an empty string when there is no loaded context", () => {
    expect(personalDataMarkdown(null, {
      categoryLabel: "全部",
      query: "",
      selectedTotal: 0,
      timeRangeLabel: "全部时间",
    })).toBe("");
  });

  it("normalizes malformed runtime personal data before markdown export", () => {
    const data = {
      ...personalData(),
      totals: { all: "bad", memory: 3 },
      sections: [
        {
          ...personalData().sections[0],
          total: "bad",
          items: [
            {
              ...personalData().sections[0].items[0],
              chips: ["review", 42, null],
              score: Number.NaN,
              payload: 42,
            },
            null,
            { id: "missing_fields" },
          ],
        },
        null,
        { key: "all", items: [] },
      ],
    } as unknown as PersonalDataResponse;

    const markdown = personalDataMarkdown(data, {
      categoryLabel: "记忆",
      query: "",
      selectedTotal: 3,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("#### 记忆 (2)");
    expect(markdown).toContain("- 状态/分数: active");
    expect(markdown).toContain("- 标签: review");
    expect(markdown).not.toContain("NaN");
    expect(markdown).not.toContain("42");
  });

  it("marks truncated personal data rows and payload fields", () => {
    const markdown = personalDataMarkdown(manyPersonalDataItems(), {
      categoryLabel: "记忆",
      query: "",
      selectedTotal: 13,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("12. Memory 12");
    expect(markdown).not.toContain("13. Memory 13");
    expect(markdown).toContain("还有 1 条当前页数据未写入复制摘要");
    expect(markdown).toContain("- field 5: value 5");
    expect(markdown).not.toContain("- field 6: value 6");
    expect(markdown).toContain("还有 1 个字段未写入复制摘要");
  });

  it("clips oversized personal data strings in exported markdown", () => {
    const data = personalData();
    data.sections[0].items[0].summary = "summary detail ".repeat(80);
    data.sections[0].items[0].payload = {
      raw_body: "raw body detail ".repeat(80),
      nested: {
        value: "nested value detail ".repeat(40),
      },
    };

    const markdown = personalDataMarkdown(data, {
      categoryLabel: "记忆",
      query: "",
      selectedTotal: 1,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("...");
    expect(markdown).not.toContain("summary detail ".repeat(80).trim());
    expect(markdown).not.toContain("raw body detail ".repeat(80).trim());
    expect(markdown).not.toContain("nested value detail ".repeat(40).trim());
  });

  it("redacts sensitive payload values from exported markdown", () => {
    const data = personalData();
    data.sections[0].items[0].payload = {
      accessToken: "secret-access-token",
      api_key: "secret-api-key",
      nested: {
        clientSecret: "secret-client-secret",
        publicLabel: "visible label",
      },
    };

    const markdown = personalDataMarkdown(data, {
      categoryLabel: "记忆",
      query: "",
      selectedTotal: 1,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("已隐藏敏感值");
    expect(markdown).toContain("visible label");
    expect(markdown).not.toContain("secret-access-token");
    expect(markdown).not.toContain("secret-api-key");
    expect(markdown).not.toContain("secret-client-secret");
  });

  it("redacts sensitive name/value payload pairs from exported markdown", () => {
    const data = personalData();
    const item = data.sections[0].items[0];
    item.payload = {
      headers: [
        {
          name: "Authorization",
          value: "Bearer secret-access-token",
        },
        {
          headerName: "X-Refresh-Token",
          rawValue: "secret-raw-token",
        },
        {
          name: "X-Public-Label",
          value: "visible label",
        },
      ],
      authPair: {
        name: "sb-refresh-token",
        value: "secret-refresh-token",
      },
    };

    expect(personalDataDisplayPayload(item)).toMatchObject({
      headers: [
        {
          name: "Authorization",
          value: "已隐藏敏感值",
        },
        {
          headerName: "X-Refresh-Token",
          rawValue: "已隐藏敏感值",
        },
        {
          name: "X-Public-Label",
          value: "visible label",
        },
      ],
      authPair: {
        name: "sb-refresh-token",
        value: "已隐藏敏感值",
      },
    });

    const markdown = personalDataMarkdown(data, {
      categoryLabel: "记忆",
      query: "",
      selectedTotal: 1,
      timeRangeLabel: "全部时间",
    });

    expect(markdown).toContain("X-Public-Label");
    expect(markdown).not.toContain("Bearer secret-access-token");
    expect(markdown).not.toContain("secret-raw-token");
    expect(markdown).not.toContain("secret-refresh-token");
  });

  it("redacts profile spotlight payload before display helpers can read it", () => {
    const item = personalData().sections[0].items[0];
    item.payload = {
      facts: {
        accessToken: "secret-access-token",
        visible: "safe fact",
      },
      preferences: {
        nested: {
          api_key: "secret-api-key",
          tone: "direct",
        },
      },
    };

    const payload = personalDataDisplayPayload(item);

    expect(payload).toMatchObject({
      facts: {
        accessToken: "已隐藏敏感值",
        visible: "safe fact",
      },
      preferences: {
        nested: {
          api_key: "已隐藏敏感值",
          tone: "direct",
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("secret-access-token");
    expect(JSON.stringify(payload)).not.toContain("secret-api-key");
  });
});

describe("personal data runtime response boundaries", () => {
  it("keeps only renderable personal data items", () => {
    expect(personalDataItem({
      id: "item_1",
      category: "memory",
      sourceLabel: "Memory",
      title: "Memory",
      chips: ["a", 1],
      score: Number.POSITIVE_INFINITY,
      payload: { value: "safe" },
    }, "memory")).toMatchObject({
      id: "item_1",
      category: "memory",
      chips: ["a"],
      score: null,
    });
    expect(personalDataItem({ category: "memory" }, "memory")).toBeNull();
    expect(personalDataItem(null, "memory")).toBeNull();
  });

  it("keeps only renderable sections and fills safe totals", () => {
    const sections = personalDataSections([
      {
        key: "memory",
        label: "记忆",
        total: "bad",
        items: [personalData().sections[0].items[0], null],
      },
      { key: "all", items: [] },
      null,
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].total).toBe(1);
    expect(sections[0].items).toHaveLength(1);
  });

  it("normalizes top-level personal data responses from the API boundary", () => {
    const normalized = personalDataResponse({
      ok: true,
      filters: { category: "bad", limit: Number.NaN, offset: 2 },
      totals: { memory: 2 },
      sections: [{
        key: "memory",
        label: "记忆",
        total: 1,
        items: [personalData().sections[0].items[0]],
      }],
    });

    expect(normalized?.filters.category).toBe("all");
    expect(normalized?.filters.limit).toBe(0);
    expect(normalized?.totals.all).toBe(1);
    expect(personalDataResponse(null)).toBeNull();
  });
});

describe("overviewSummaryText", () => {
  it("keeps overview failures local to the summary", () => {
    expect(overviewSummaryText({
      activeCategoryCount: 3,
      overviewError: "service unavailable",
      overviewLoading: false,
    })).toBe("概况刷新失败。");
  });

  it("describes loading and loaded overview states", () => {
    expect(overviewSummaryText({
      activeCategoryCount: 0,
      overviewError: null,
      overviewLoading: true,
    })).toBe("正在刷新概况。");
    expect(overviewSummaryText({
      activeCategoryCount: 4,
      overviewError: null,
      overviewLoading: false,
    })).toBe("4 类有数据。");
  });
});

describe("personal data copy readiness", () => {
  it("prevents copying stale data while a filtered view is loading", () => {
    expect(canCopyPersonalDataView(personalData(), true)).toBe(false);
  });

  it("prevents copying stale data after a refresh error", () => {
    expect(canCopyPersonalDataView(personalData(), false, "network failed")).toBe(false);
  });

  it("allows copying after the current view has loaded", () => {
    expect(canCopyPersonalDataView(personalData(), false)).toBe(true);
  });

  it("does not copy before any view data has loaded", () => {
    expect(canCopyPersonalDataView(null, false)).toBe(false);
  });

  it("explains why the current personal data view cannot be copied", () => {
    expect(personalDataCopyUnavailableMessage(false, null, "个人数据时间开始日期不能晚于结束日期。")).toBe(
      "当前筛选条件无效，先修正后再复制。",
    );
    expect(personalDataCopyUnavailableMessage(true, null, null)).toBe("正在读取当前视图，加载完成后再复制。");
    expect(personalDataCopyUnavailableMessage(false, "network failed", null)).toBe("当前视图刷新失败，先重新加载成功后再复制。");
    expect(personalDataCopyUnavailableMessage(false, null, null)).toBe("当前视图没有可复制上下文。");
  });
});

describe("personal data refresh errors", () => {
  it("blocks the page only before the first successful load", () => {
    expect(personalDataBlockingError("network failed", false)).toBe(true);
    expect(personalDataBlockingError("network failed", true, "same", "same")).toBe(false);
    expect(personalDataBlockingError(null, false)).toBe(false);
    expect(personalDataBlockingError(
      "个人数据时间开始日期不能晚于结束日期。",
      false,
      "new-filters",
      null,
      "个人数据时间开始日期不能晚于结束日期。",
    )).toBe(false);
  });

  it("keeps controls visible when a changed query fails after a previous load", () => {
    expect(personalDataBlockingError("network failed", true, "new-filters", "old-filters")).toBe(false);
  });

  it("hides stale rows as soon as the visible query changes", () => {
    expect(personalDataHideStaleRows(true, "new-filters", "old-filters")).toBe(true);
    expect(personalDataHideStaleRows(true, "same", "same")).toBe(false);
    expect(personalDataHideStaleRows(false, "new-filters", "old-filters")).toBe(false);
  });

  it("hides stale overview totals as soon as the overview query changes", () => {
    expect(personalDataHideStaleOverview("new-search", "old-search")).toBe(true);
    expect(personalDataHideStaleOverview("same", "same")).toBe(false);
    expect(personalDataHideStaleOverview("new-search", null)).toBe(false);
  });

  it("keeps later refresh failures local to the existing personal data context", () => {
    expect(personalDataRefreshErrorText("network failed", false)).toBeNull();
    expect(personalDataRefreshErrorText(null, true, "same", "same")).toBeNull();
    expect(personalDataRefreshErrorText("network failed", true, "same", "same")).toBe(
      "个人数据刷新失败，当前仍显示上一次成功加载的数据：network failed",
    );
    expect(personalDataRefreshErrorText("network failed", true, "new-filters", "old-filters")).toBe(
      "个人数据刷新失败，当前筛选还没有成功加载结果：network failed",
    );
  });

  it("reports reversed personal data date filters before requesting a misleading empty view", () => {
    expect(personalDataFilterError({ since: "2026-05-15", until: "2026-05-14" })).toBe(
      "个人数据时间开始日期不能晚于结束日期。",
    );
    expect(personalDataFilterError({ since: "2026-05-14", until: "2026-05-15" })).toBeNull();
    expect(personalDataEmptyStateTitle("个人数据时间开始日期不能晚于结束日期。")).toBe("个人数据筛选条件无效");
    expect(personalDataEmptyStateTitle(null)).toBe("个人数据加载失败");
  });

  it("reports overlong personal data search queries before the API rejects them", () => {
    expect(personalDataFilterError({
      query: "x".repeat(PERSONAL_DATA_QUERY_MAX_LENGTH + 1),
      since: "",
      until: "",
    })).toBe(`个人数据搜索词最多 ${PERSONAL_DATA_QUERY_MAX_LENGTH} 个字符。`);
  });

  it("keeps successful empty filtered views explicit instead of blank", () => {
    expect(personalDataNoSectionsMessage("记忆")).toBe("当前筛选下没有记忆数据。");
    expect(personalDataNoSectionsMessage(undefined)).toBe("当前筛选下没有个人数据。");
  });
});
