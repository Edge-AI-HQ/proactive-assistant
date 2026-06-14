import { describe, expect, test } from "vitest";

import {
  parseControlMode,
  parseDeviceKind,
  reduceBrowserSession,
  type BrowserEnvelope,
} from "./browser-session";

const opened: BrowserEnvelope = {
  type: "browser:opened",
  data: {
    sessionKey: "s1",
    bbSessionId: "bb1",
    liveViewUrl: "url",
    deviceKind: "mobile",
    controlMode: "user",
    url: "https://x",
  },
};

describe("parseControlMode / parseDeviceKind", () => {
  test("control mode 非 user 一律 ai", () => {
    expect(parseControlMode("user")).toBe("user");
    expect(parseControlMode("nonsense")).toBe("ai");
  });
  test("device kind 非 mobile/tablet 一律 desktop", () => {
    expect(parseDeviceKind("tablet")).toBe("tablet");
    expect(parseDeviceKind(undefined)).toBe("desktop");
  });
});

describe("reduceBrowserSession", () => {
  test("opened 建立 session", () => {
    expect(reduceBrowserSession(null, opened)).toMatchObject({
      sessionKey: "s1",
      bbSessionId: "bb1",
      deviceKind: "mobile",
      controlMode: "user",
      currentUrl: "https://x",
    });
  });

  test("opened 缺 sessionKey/bbSessionId 不建立", () => {
    expect(reduceBrowserSession(null, { type: "browser:opened", data: { sessionKey: "s1" } })).toBeNull();
  });

  test("closed 清空", () => {
    expect(reduceBrowserSession(reduceBrowserSession(null, opened), { type: "browser:closed" })).toBeNull();
  });

  test("navigated 更新 currentUrl", () => {
    const s = reduceBrowserSession(null, opened);
    expect(reduceBrowserSession(s, { type: "browser:navigated", data: { url: "https://y" } })?.currentUrl).toBe("https://y");
  });

  test("control:takeover 设 mode + reason", () => {
    const s = reduceBrowserSession(null, opened);
    const t = reduceBrowserSession(s, {
      type: "browser:control:takeover",
      data: { controlMode: "ai", reason: "AI needs control" },
    });
    expect(t?.controlMode).toBe("ai");
    expect(t?.takeoverReason).toBe("AI needs control");
  });

  test("未知事件原样返回 prev", () => {
    const s = reduceBrowserSession(null, opened);
    expect(reduceBrowserSession(s, { type: "whatever" })).toBe(s);
  });
});
