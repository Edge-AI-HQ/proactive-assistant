import { useEffect, useState } from "react";
import type { CasebookLabel } from "@/api/reward";
import { upsertCasebook } from "@/api/reward";

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

interface CasebookEditorProps {
  cardId: string;
  initialLabel?: CasebookLabel;
  initialNote?: string | null;
  onSaved: () => void;
}

export function CasebookEditor({
  cardId,
  initialLabel = "great",
  initialNote,
  onSaved,
}: CasebookEditorProps) {
  const [label, setLabel] = useState<CasebookLabel>(initialLabel);
  const [note, setNote] = useState(initialNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(initialLabel);
    setNote(initialNote ?? "");
    setError(null);
  }, [cardId, initialLabel, initialNote]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await upsertCasebook(cardId, label, note);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="casebook-editor">
      <select value={label} onChange={(event) => setLabel(event.target.value as CasebookLabel)}>
        {labels.map((item) => (
          <option value={item} key={item}>{labelText[item]}</option>
        ))}
      </select>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="评审备注"
        rows={3}
      />
      <button className="primary-button" onClick={save} disabled={saving}>
        {saving ? "保存中" : "保存到样本库"}
      </button>
      {error && <div className="inline-error">{error}</div>}
    </div>
  );
}
