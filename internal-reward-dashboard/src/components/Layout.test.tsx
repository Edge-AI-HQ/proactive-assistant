import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Layout } from "./Layout";

function renderLayout(avatarUrl: string | null) {
  return renderToStaticMarkup(
    <Layout
      avatarUrl={avatarUrl}
      email="sam@example.test"
      name="Sam Reviewer"
      onNavigate={() => undefined}
      onSignOut={() => undefined}
      route="/runs"
    >
      <div>dashboard body</div>
    </Layout>,
  );
}

describe("Layout account chrome", () => {
  it("renders only sanitized http avatars", () => {
    const safeMarkup = renderLayout(" https://example.test/avatar.png ");
    const unsafeMarkup = renderLayout("javascript:alert(1)");

    expect(safeMarkup).toContain('src="https://example.test/avatar.png"');
    expect(unsafeMarkup).not.toContain("javascript:alert");
    expect(unsafeMarkup).toContain(">S</span>");
  });
});
