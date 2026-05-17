import { afterEach, describe, expect, test, vi } from "vitest";

import { BrowserSpeechEngine } from "./BrowserSpeechEngine";

describe("BrowserSpeechEngine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  test("keeps the full transcript as browser result segments advance", () => {
    const Recognition = installMockRecognition();
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const engine = new BrowserSpeechEngine({ lang: "zh-CN" });

    engine.start({ onPartial, onFinal, onError: vi.fn() });
    const recognition = Recognition.instances[0];

    recognition.onresult?.({
      resultIndex: 0,
      results: recognitionResults([
        ["今天我们", true],
        ["测试一段", false],
      ]),
    });
    recognition.onresult?.({
      resultIndex: 1,
      results: recognitionResults([
        ["今天我们", true],
        ["测试一段比较长的语音输入", true],
      ]),
    });

    expect(onFinal).toHaveBeenLastCalledWith("今天我们测试一段比较长的语音输入");
    expect(onPartial).not.toHaveBeenCalledWith("测试一段比较长的语音输入");
  });

  test("resolves stop after the browser emits final result and end", async () => {
    const Recognition = installMockRecognition();
    const onFinal = vi.fn();
    const engine = new BrowserSpeechEngine({ lang: "zh-CN" });

    const handle = engine.start({ onPartial: vi.fn(), onFinal, onError: vi.fn() });
    const recognition = Recognition.instances[0];
    let resolved = false;
    const stopped = handle.stop();
    if (stopped) void stopped.then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);

    recognition.onresult?.({
      resultIndex: 0,
      results: recognitionResults([["最终完整文本", true]]),
    });
    recognition.onend?.();
    await stopped;

    expect(onFinal).toHaveBeenCalledWith("最终完整文本");
    expect(resolved).toBe(true);
  });
});

function installMockRecognition() {
  class MockRecognition {
    static instances: MockRecognition[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: MockSpeechRecognitionEvent) => void) | null = null;
    onerror: ((event: { error?: unknown }) => void) | null = null;
    onend: ((event?: unknown) => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();

    constructor() {
      MockRecognition.instances.push(this);
    }
  }

  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: MockRecognition,
  });
  return MockRecognition;
}

function recognitionResults(parts: Array<[string, boolean]>) {
  return parts.map(([transcript, isFinal]) => ({
    0: { transcript },
    isFinal,
  }));
}

interface MockSpeechRecognitionEvent {
  resultIndex?: number;
  results: Array<{ 0: { transcript: string }; isFinal: boolean }>;
}
