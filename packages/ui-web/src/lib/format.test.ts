import { afterEach, describe, expect, test } from "vitest";

import i18n from "../i18n";
import { formatDate, formatRelativeTime, formatTime } from "./format";

describe("locale-aware format helpers", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  test("formatDate 跟随当前 UI 语言", async () => {
    const d = new Date("2026-06-12T08:30:00Z");
    expect(formatDate(d)).toMatch(/Jun/); // en: "Jun 12, 2026"
    await i18n.changeLanguage("zh-Hans");
    expect(formatDate(d)).toMatch(/6月/); // zh: "2026年6月12日"
  });

  test("formatTime 跟随当前 UI 语言的钟制习惯", () => {
    const d = new Date("2026-06-12T20:05:00Z");
    expect(formatTime(d)).toMatch(/8:05|20:05/);
  });

  test("formatRelativeTime 输出本地化相对时间", async () => {
    const now = new Date("2026-06-12T12:00:00Z");
    expect(formatRelativeTime(new Date("2026-06-12T11:55:00Z"), now)).toBe("5 minutes ago");
    await i18n.changeLanguage("zh-Hans");
    expect(formatRelativeTime(new Date("2026-06-12T11:55:00Z"), now)).toBe("5分钟前");
  });

  test("刚刚发生显示秒级", () => {
    const now = new Date("2026-06-12T12:00:00Z");
    expect(formatRelativeTime(new Date("2026-06-12T11:59:58Z"), now)).toMatch(/second/);
  });
});
