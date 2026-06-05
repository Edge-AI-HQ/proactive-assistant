import { vi } from "vitest";

// Pin the test timezone to UTC so time-of-day logic that relies on local hours
// (e.g. the ambient timeline morning_health cutoff via Date.getHours()) is
// deterministic across machines. CI runners are UTC; without this a fixture like
// "2026-05-15T05:00:00.000Z" reads as 05:00 (morning) on CI but 22:00/13:00
// (not morning) in a developer's local TZ, so a test can pass locally yet fail
// in CI. Setting TZ before any Date is constructed makes both agree.
process.env.TZ = "UTC";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => {
      store.clear();
    }),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: createMemoryStorage(),
});

const ResizeObserverMock = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (!globalThis.ResizeObserver) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
}

vi.mock("lucide-react", () => new Proxy(
  { __esModule: true },
  {
    has(_target, property) {
      return property !== "then";
    },
    get(target, property) {
      if (property === "then") return undefined;
      if (property in target) return target[property as keyof typeof target];
      return () => null;
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === "then") return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: () => null,
      };
    },
  },
));
