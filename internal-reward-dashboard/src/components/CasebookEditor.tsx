import { useEffect, useRef, useState } from "react";
import type { CasebookLabel } from "@/api/reward";
import { CASEBOOK_REVIEWER_NOTE_MAX_LENGTH, upsertCasebook } from "@/api/reward";
import { firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";

export { CASEBOOK_REVIEWER_NOTE_MAX_LENGTH } from "@/api/reward";

const labels: CasebookLabel[] = [
  "great",
  "bad",
  "surprising",
  "generic",
  "hallucinated",
  "duplicate",
  "mistimed",
  "weak_source",
];
const labelValues = new Set<string>(labels);

const labelText: Record<CasebookLabel, string> = {
  great: "好样本",
  bad: "坏样本",
  surprising: "惊喜",
  generic: "泛化",
  hallucinated: "幻觉",
  duplicate: "重复",
  mistimed: "时机不对",
  weak_source: "证据弱",
};

export function casebookSaveErrorMessage(saved: boolean, err: unknown): string {
  const message = err instanceof Error ? err.message : "保存失败";
  return saved ? `样本已保存，但页面刷新失败：${message}` : message;
}

export const missingCasebookCardMessage = "当前卡片缺少 ID，不能保存到样本库。";

export function casebookEditorCardId(cardId: string): string {
  return firstDashboardRouteId(cardId);
}

export function casebookEditorLabel(value: unknown): CasebookLabel {
  return typeof value === "string" && labelValues.has(value) ? value as CasebookLabel : "great";
}

export function casebookEditorDisabledReason(
  disabled: boolean,
  disabledReason: string | undefined,
  cardMutationId: string,
): string | undefined {
  if (disabled) return disabledReason?.trim() || missingCasebookCardMessage;
  if (!hasDashboardRouteId(cardMutationId)) return missingCasebookCardMessage;
  return undefined;
}

interface CasebookEditorProps {
  cardId: string;
  disabled?: boolean;
  disabledReason?: string;
  initialLabel?: CasebookLabel;
  initialNote?: string | null;
  onSaved: () => void | Promise<void>;
}

export function CasebookEditor({
  cardId,
  disabled = false,
  disabledReason,
  initialLabel = "great",
  initialNote,
  onSaved,
}: CasebookEditorProps) {
  const [label, setLabel] = useState<CasebookLabel>(() => casebookEditorLabel(initialLabel));
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const cardMutationId = casebookEditorCardId(cardId);
  const activeCardMutationIdRef = useRef(cardMutationId);
  activeCardMutationIdRef.current = cardMutationId;
  const effectiveDisabledReason = casebookEditorDisabledReason(disabled, disabledReason, cardMutationId);

  useEffect(() => {
    setLabel(casebookEditorLabel(initialLabel));
    setNote(initialNote ?? "");
    setError(null);
    setStatus(null);
  }, [cardId, initialLabel, initialNote]);

  function clearSaveState() {
    setError(null);
    setStatus(null);
  }

  async function save() {
    if (effectiveDisabledReason) {
      setError(effectiveDisabledReason);
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    let saved = false;
    const mutationCardId = cardMutationId;
    try {
      await upsertCasebook(mutationCardId, label, note);
      saved = true;
      if (activeCardMutationIdRef.current !== mutationCardId) return;
      await onSaved();
      if (activeCardMutationIdRef.current !== mutationCardId) return;
      setStatus("已保存到样本库。");
    } catch (err) {
      if (activeCardMutationIdRef.current !== mutationCardId) return;
      setError(casebookSaveErrorMessage(saved, err));
    } finally {
      if (activeCardMutationIdRef.current === mutationCardId) {
        setSaving(false);
      }
    }
  }

  const controlsDisabled = saving || Boolean(effectiveDisabledReason);

  return (
    <div className="casebook-editor">
      <select
        aria-label="保存到样本库的标签"
        disabled={controlsDisabled}
        value={label}
        onChange={(event) => {
          setLabel(casebookEditorLabel(event.target.value));
          clearSaveState();
        }}
      >
        {labels.map((item, index) => (
          <option value={item} key={`casebook-label-${index}`}>{labelText[item]}</option>
        ))}
      </select>
      <textarea
        aria-label="样本库评审备注"
        disabled={controlsDisabled}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          clearSaveState();
        }}
        maxLength={CASEBOOK_REVIEWER_NOTE_MAX_LENGTH}
        placeholder="评审备注"
        rows={3}
      />
      <button className="primary-button" onClick={save} disabled={controlsDisabled} type="button">
        {saving ? "保存中" : "保存到样本库"}
      </button>
      {effectiveDisabledReason && <div className="muted">{effectiveDisabledReason}</div>}
      {status && <div className="inline-status" role="status">{status}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div>
  );
}
