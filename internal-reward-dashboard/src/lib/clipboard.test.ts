import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

function setClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: writeText ? { clipboard: { writeText } } : {},
  });
}

describe("copyText", () => {
  it("returns true when clipboard write succeeds", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);

    await expect(copyText("review note")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("review note");
  });

  it("returns false when clipboard is unavailable or throws", async () => {
    setClipboard();
    await expect(copyText("review note")).resolves.toBe(false);

    setClipboard(async () => {
      throw new Error("blocked");
    });
    await expect(copyText("review note")).resolves.toBe(false);
  });
});
