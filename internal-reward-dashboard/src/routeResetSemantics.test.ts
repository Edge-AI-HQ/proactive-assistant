import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("./routes/{CardView,RunDetailView,TraceView}.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("route reset semantics", () => {
  it("clears stale page-level errors before loading a new card", () => {
    const source = routeSources["./routes/CardView.tsx"];

    expect(source).toContain("setError(null);\n    void load();");
  });

  it("clears stale page-level errors before loading a new run detail", () => {
    const source = routeSources["./routes/RunDetailView.tsx"];

    expect(source).toContain("setError(null);\n    void load();");
  });

  it("clears stale page-level errors before loading a new trace", () => {
    const source = routeSources["./routes/TraceView.tsx"];

    expect(source).toContain("setError(null);\n    void load();");
    expect(source).toContain("traceRef.current = null");
  });
});
