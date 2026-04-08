import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import GenerationLanguageSettings from "./GenerationLanguageSettings";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("GenerationLanguageSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("loads the saved language and persists a new selection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        language: "en",
        options: [
          { value: "en", label: "English" },
          { value: "ja", label: "Japanese" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        language: "ja",
        options: [
          { value: "en", label: "English" },
          { value: "ja", label: "Japanese" },
        ],
      }));

    await act(async () => {
      root.render(<GenerationLanguageSettings />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const select = container.querySelector('select[aria-label="Generation language"]') as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect(select?.value).toBe("en");

    await act(async () => {
      select!.value = "ja";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/proactive-ai/rpc/settings/generation-language",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ language: "ja" }),
      }),
    );
    expect(select?.value).toBe("ja");
    expect(container.querySelector('[aria-label="Saved"]')).toBeTruthy();
  });

  it("reverts the selection when save fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        language: "en",
        options: [
          { value: "en", label: "English" },
          { value: "fr", label: "French" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: "Unsupported generation language",
      }, { status: 400 }));

    await act(async () => {
      root.render(<GenerationLanguageSettings />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const select = container.querySelector('select[aria-label="Generation language"]') as HTMLSelectElement | null;
    expect(select?.value).toBe("en");

    await act(async () => {
      select!.value = "fr";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(select?.value).toBe("en");
    expect(container.textContent).toContain("Unsupported generation language");
  });
});
