import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import AmbientModelRequiredCard from "./AmbientModelRequiredCard";

describe("AmbientModelRequiredCard", () => {
  test("prompts users to download Gemma 2B for local summaries", () => {
    const onOpenSetup = vi.fn();

    render(<AmbientModelRequiredCard onOpenSetup={onOpenSetup} />);

    expect(screen.getByText(/On-device LLM required/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /download gemma 2b/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /download gemma 2b/i }));
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });
});
