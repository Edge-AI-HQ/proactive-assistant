import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScoreControl } from "./ScoreControl";

describe("ScoreControl", () => {
  const buttonTagStart = "<" + "button";

  it("disables the current score so repeated clicks do not append duplicate reviewer events", () => {
    const markup = renderToStaticMarkup(
      <ScoreControl current={7} onScore={vi.fn()} />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="当前 7 分"');
    expect(markup).toContain("disabled");
  });

  it("keeps non-current scores actionable", () => {
    const markup = renderToStaticMarkup(
      <ScoreControl current={7} onScore={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="打 8 分"');
  });

  it("explains why all score buttons are disabled", () => {
    const markup = renderToStaticMarkup(
      <ScoreControl
        current={null}
        disabled
        disabledReason="当前卡片缺少 ID，不能保存人工评分。"
        onScore={vi.fn()}
      />,
    );

    expect(markup).toContain("当前卡片缺少 ID，不能保存人工评分。");
    expect(markup).toContain("aria-describedby=");
    expect(markup.split(buttonTagStart)).toHaveLength(11);
    expect(markup.match(/disabled=""/g)).toHaveLength(10);
  });
});
