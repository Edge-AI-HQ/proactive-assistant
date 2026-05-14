import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
  CasebookEditor,
  casebookEditorCardId,
  casebookEditorDisabledReason,
  casebookEditorLabel,
  casebookSaveErrorMessage,
  missingCasebookCardMessage,
} from "./CasebookEditor";

const componentSources = import.meta.glob("./CasebookEditor.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("CasebookEditor", () => {
  it("distinguishes save failures from post-save refresh failures", () => {
    expect(casebookSaveErrorMessage(false, new Error("forbidden"))).toBe("forbidden");
    expect(casebookSaveErrorMessage(true, new Error("reload failed"))).toBe(
      "样本已保存，但页面刷新失败：reload failed",
    );
  });

  it("normalizes card ids before saving", () => {
    expect(casebookEditorCardId(" card_1 ")).toBe("card_1");
    expect(casebookEditorCardId("   ")).toBe("");
  });

  it("normalizes unknown initial labels to a valid save label", () => {
    expect(casebookEditorLabel("bad")).toBe("bad");
    expect(casebookEditorLabel("unknown_label")).toBe("great");
    expect(casebookEditorLabel(null)).toBe("great");
  });

  it("guards missing card ids before calling the API", () => {
    expect(casebookEditorDisabledReason(false, undefined, "")).toBe(missingCasebookCardMessage);
    expect(casebookEditorDisabledReason(true, undefined, "card_1")).toBe(missingCasebookCardMessage);
    expect(casebookEditorDisabledReason(true, "   ", "card_1")).toBe(missingCasebookCardMessage);
    expect(casebookEditorDisabledReason(true, "不能保存", "card_1")).toBe("不能保存");
    expect(casebookEditorDisabledReason(false, undefined, "card_1")).toBeUndefined();
  });

  it("limits reviewer notes to the backend accepted length", () => {
    const markup = renderToStaticMarkup(createElement(CasebookEditor, {
      cardId: "card_1",
      onSaved: () => undefined,
    }));

    expect(markup).toContain(`maxLength="${CASEBOOK_REVIEWER_NOTE_MAX_LENGTH}"`);
  });

  it("does not write stale save results after the card id changes", () => {
    const source = componentSources["./CasebookEditor.tsx"];
    expect(source).toContain("const activeCardMutationIdRef = useRef(cardMutationId)");
    expect(source).toContain("activeCardMutationIdRef.current = cardMutationId");
    expect(source).toContain("const mutationCardId = cardMutationId");
    expect(source).toContain("activeCardMutationIdRef.current !== mutationCardId");
    expect(source).toContain("activeCardMutationIdRef.current === mutationCardId");
  });
});
