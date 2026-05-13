import { vi } from "vitest";

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
