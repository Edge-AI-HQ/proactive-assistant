// Sync-A 白名单红线：只有 settings/cards 进持久层，消息体类 key 永不
// 持久化（Claude Desktop 单 blob 写放大事故的防线——同步引擎文档 §2.2）。
import { describe, expect, test } from "vitest";

import { isPersistableQueryKey } from "./query-client";

describe("persist allowlist", () => {
  test("settings and cards keys are persistable", () => {
    expect(isPersistableQueryKey(["user-settings"])).toBe(true);
    expect(isPersistableQueryKey(["cards", { limit: 200 }])).toBe(true);
  });

  test("everything else — especially conversation/message-shaped keys — is NOT", () => {
    expect(isPersistableQueryKey(["memories", {}])).toBe(false);
    expect(isPersistableQueryKey(["skills", {}])).toBe(false);
    expect(isPersistableQueryKey(["agent-runs", "active"])).toBe(false);
    expect(isPersistableQueryKey(["user-devices"])).toBe(false);
    expect(isPersistableQueryKey(["conversation", "history"])).toBe(false);
  });
});
