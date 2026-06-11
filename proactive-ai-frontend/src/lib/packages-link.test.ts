// Phase 0 管道验证：现 app 能从源码直引 @pin-ai/core / @pin-ai/state
// （vite alias + tsconfig paths 双链路）。分层 Phase 1+ 出现真实消费后可删。
import { describe, expect, it } from "vitest";

import { PIN_AI_CORE } from "@pin-ai/core";
import { PIN_AI_STATE } from "@pin-ai/state";

describe("workspace packages source-link", () => {
  it("resolves shared packages from source", () => {
    expect(PIN_AI_CORE).toBe("@pin-ai/core");
    expect(PIN_AI_STATE).toBe("@pin-ai/state");
  });
});
