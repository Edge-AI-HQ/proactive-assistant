/**
 * MemoriesPanel — debug-panel card for managing v3 `memory` rows.
 *
 * Shows rows by status (active / archived / superseded), with filters for
 * subject prefix and min quality. Supports inline edit (text / subject /
 * quality / tags), archive (soft-delete), and supersede (create new + link
 * old). No hard delete — v3 treats memory as an append-only ledger.
 *
 * Matches the visual language of CrystallizePanel and SkillsPanel.
 */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Archive,
  Save,
  X,
  GitBranch,
} from "lucide-react";
import { useMemories } from "@pin-ai/state";
import type { Memory, MemoryStatus } from "@pin-ai/core";
import { cn } from "@/lib/utils";

interface MemoriesPanelProps {
  enabled: boolean;
}

const STATUS_TABS: Array<{ key: MemoryStatus; label: string }> = [
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "superseded", label: "Superseded" },
];

const STATUS_STYLES: Record<MemoryStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  archived: "bg-foreground/5 text-foreground/50 border-foreground/10",
  superseded: "bg-amber-50 text-amber-700 border-amber-200",
};

const SUBJECT_PRESETS = ["", "self", "person:", "topic:", "goal:", "place:"];
const PAGE_SIZE = 5;

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const diff = Date.now() - parsed;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function qualityColor(q: number): string {
  if (q >= 0.75) return "bg-emerald-500";
  if (q >= 0.5) return "bg-foreground/50";
  return "bg-amber-400";
}

export default function MemoriesPanel({ enabled }: MemoriesPanelProps) {
  const { memories, total, loading, mutating, error, filter, setFilter, refetch, create, update, archive, supersede } =
    useMemories(enabled);

  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const status = filter.status ?? "active";
  const pageSize = filter.limit ?? PAGE_SIZE;
  const page = Math.floor((filter.offset ?? 0) / pageSize);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const firstVisible = total === 0 ? 0 : page * pageSize + 1;
  const lastVisible = Math.min(total, page * pageSize + memories.length);
  const setStatus = (next: MemoryStatus) => setFilter({ ...filter, status: next, limit: pageSize, offset: 0 });

  const subjectPrefix = filter.subjectPrefix ?? "";
  const minQuality = filter.minQuality ?? 0;
  const setPage = (nextPage: number) => {
    const bounded = Math.max(0, Math.min(maxPage, nextPage));
    setFilter({ ...filter, limit: pageSize, offset: bounded * pageSize });
  };

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Brain size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">Memories</span>
          {loading && (
            <Loader2 size={11} className="animate-spin text-foreground/30" strokeWidth={1.5} />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void refetch()}
            disabled={loading}
            title="Refresh"
            className="p-1 rounded-md text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 disabled:opacity-40"
          >
            <RefreshCw size={11} strokeWidth={1.5} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => setCreating((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md bg-foreground text-background text-[10px] font-semibold px-2 py-1 hover:bg-foreground/85"
          >
            <Plus size={10} strokeWidth={2} />
            New
          </button>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 mb-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatus(tab.key)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
              status === tab.key
                ? "bg-foreground text-background"
                : "bg-foreground/5 text-foreground/50 hover:bg-foreground/10",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 mb-2">
        <select
          value={subjectPrefix}
          onChange={(e) => setFilter({
            ...filter,
            subjectPrefix: e.target.value || undefined,
            limit: pageSize,
            offset: 0,
          })}
          className="rounded-md bg-white/60 border border-foreground/10 px-1.5 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          {SUBJECT_PRESETS.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "subject: any" : s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[10px] text-foreground/50">
          <span>min q</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={minQuality}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFilter({
                ...filter,
                minQuality: Number.isFinite(v) && v > 0 ? v : undefined,
                limit: pageSize,
                offset: 0,
              });
            }}
            className="w-14 rounded-md bg-white/60 border border-foreground/10 px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <span className="text-[10px] text-foreground/40 ml-auto tabular-nums">
          {total === 0 ? "0 rows" : `${firstVisible}-${lastVisible} of ${total}`}
        </span>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden mb-2"
          >
            <CreateMemoryForm
              mutating={mutating}
              onCancel={() => setCreating(false)}
              onSubmit={async (input) => {
                const created = await create(input);
                if (created) setCreating(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      <div className="space-y-1">
        {memories.length === 0 && !loading && (
          <div className="text-[10px] text-foreground/40 py-3 text-center">No {status} memories.</div>
        )}
        {memories.map((m) => (
          <MemoryRow
            key={m.id}
            memory={m}
            expanded={expandedId === m.id}
            onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
            mutating={mutating}
            onUpdate={(patch) => update(m.id, patch)}
            onArchive={() => archive(m.id)}
            onSupersede={(newText) =>
              supersede(m.id, {
                text: newText,
                source: m.source.startsWith("manual") ? "manual" : `manual:revised-from-${m.source}`,
                subject: m.subject,
                quality: m.quality,
                tags: m.tags,
              })
            }
          />
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-foreground/5 pt-2">
        <span className="text-[10px] text-foreground/35 tabular-nums">
          Page {total === 0 ? 0 : page + 1} / {total === 0 ? 0 : maxPage + 1}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={page <= 0 || loading}
            title="Previous page"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-white/60 text-foreground/45 hover:bg-white/90 disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={13} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={page >= maxPage || loading || total === 0}
            title="Next page"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-white/60 text-foreground/45 hover:bg-white/90 disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <ChevronRight size={13} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-[10px] text-red-500 leading-snug">{error}</p>}
    </div>
  );
}

interface MemoryRowProps {
  memory: Memory;
  expanded: boolean;
  mutating: boolean;
  onToggle: () => void;
  onUpdate: (patch: Parameters<ReturnType<typeof useMemories>["update"]>[1]) => Promise<Memory | null>;
  onArchive: () => Promise<boolean>;
  onSupersede: (newText: string) => Promise<Memory | null>;
}

function MemoryRow({ memory, expanded, mutating, onToggle, onUpdate, onArchive, onSupersede }: MemoryRowProps) {
  const [text, setText] = useState(memory.text);
  const [subject, setSubject] = useState(memory.subject ?? "");
  const [quality, setQuality] = useState(memory.quality);
  const [tagsText, setTagsText] = useState(memory.tags.join(", "));
  const [supersedeDraft, setSupersedeDraft] = useState("");
  const [supersedeOpen, setSupersedeOpen] = useState(false);

  const dirty = useMemo(() => {
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    return (
      text !== memory.text
      || (subject || null) !== memory.subject
      || quality !== memory.quality
      || tags.join("|") !== memory.tags.join("|")
    );
  }, [text, subject, quality, tagsText, memory]);

  const save = async () => {
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    await onUpdate({
      text: text.trim() || memory.text,
      subject: subject.trim() ? subject.trim() : null,
      quality,
      tags,
    });
  };

  return (
    <div className="rounded-lg border border-foreground/10 bg-white/50">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-foreground/5 transition-colors"
      >
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            STATUS_STYLES[memory.status],
          )}
        >
          {memory.status}
        </span>
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="text-[11px] text-foreground leading-snug line-clamp-2">{memory.text}</p>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[9px] text-foreground/40">
            {memory.subject && (
              <span className="min-w-0 max-w-[72px] truncate rounded bg-foreground/5 px-1 py-px font-medium">
                {memory.subject}
              </span>
            )}
            <span className="min-w-0 max-w-[92px] truncate rounded bg-foreground/5 px-1 py-px">
              {memory.source}
            </span>
            {memory.tags.slice(0, 3).map((t) => (
              <span key={t} className="max-w-[76px] truncate rounded bg-blue-50 px-1 py-px text-blue-700">#{t}</span>
            ))}
            {memory.tags.length > 3 && <span className="text-foreground/30">+{memory.tags.length - 3}</span>}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            <div className="w-8 h-1 rounded-full bg-foreground/10 overflow-hidden">
              <div
                className={cn("h-full", qualityColor(memory.quality))}
                style={{ width: `${Math.round(memory.quality * 100)}%` }}
              />
            </div>
            <span className="text-[9px] font-mono tabular-nums text-foreground/50">
              {memory.quality.toFixed(2)}
            </span>
          </div>
          <div className="text-[9px] text-foreground/40 tabular-nums">{relativeTime(memory.created_at)}</div>
        </div>
        <ChevronDown
          size={11}
          strokeWidth={1.5}
          className={cn("shrink-0 mt-1 text-foreground/30 transition-transform", expanded && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-foreground/10"
          >
            <div className="p-2.5 space-y-2">
              <label className="block">
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Text</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Subject</span>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="self / person:alice / topic:coffee"
                    className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </label>
                <label className="block">
                  <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
                    Quality
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
                  Tags (comma-separated)
                </span>
                <input
                  type="text"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => void save()}
                  disabled={!dirty || mutating}
                  className="inline-flex items-center gap-1 rounded-md bg-foreground text-background text-[10px] font-semibold px-2 py-1 disabled:opacity-40"
                >
                  {mutating ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                  Save
                </button>
                {memory.status === "active" && (
                  <>
                    <button
                      onClick={() => setSupersedeOpen((v) => !v)}
                      disabled={mutating}
                      className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-white/60 text-foreground/70 text-[10px] font-medium px-2 py-1 hover:bg-foreground/5 disabled:opacity-40"
                    >
                      <GitBranch size={10} />
                      Supersede
                    </button>
                    <button
                      onClick={() => void onArchive()}
                      disabled={mutating}
                      className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-white/60 text-foreground/70 text-[10px] font-medium px-2 py-1 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-40"
                    >
                      <Archive size={10} />
                      Archive
                    </button>
                  </>
                )}
              </div>

              {supersedeOpen && (
                <div className="rounded-md border border-blue-200 bg-blue-50/50 p-2 space-y-1.5">
                  <span className="text-[9px] font-medium text-blue-700 uppercase tracking-wider">
                    Replacement text
                  </span>
                  <textarea
                    value={supersedeDraft}
                    onChange={(e) => setSupersedeDraft(e.target.value)}
                    rows={3}
                    placeholder="New, corrected version of this memory"
                    className="w-full rounded-md bg-white/80 border border-blue-200 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => {
                        if (!supersedeDraft.trim()) return;
                        const ok = await onSupersede(supersedeDraft.trim());
                        if (ok) {
                          setSupersedeDraft("");
                          setSupersedeOpen(false);
                        }
                      }}
                      disabled={!supersedeDraft.trim() || mutating}
                      className="rounded-md bg-blue-600 text-white text-[10px] font-semibold px-2 py-1 disabled:opacity-40"
                    >
                      Confirm supersede
                    </button>
                    <button
                      onClick={() => setSupersedeOpen(false)}
                      className="rounded-md border border-blue-200 bg-white/60 text-blue-700 text-[10px] font-medium px-2 py-1 hover:bg-white"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface CreateMemoryFormProps {
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    text: string;
    source: string;
    subject?: string | null;
    quality?: number;
    tags?: string[];
  }) => Promise<void>;
}

function CreateMemoryForm({ mutating, onCancel, onSubmit }: CreateMemoryFormProps) {
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("self");
  const [quality, setQuality] = useState(0.6);
  const [tagsText, setTagsText] = useState("");

  const disabled = !text.trim() || mutating;

  return (
    <div className="rounded-lg border border-foreground/10 bg-white/70 p-2.5 space-y-2">
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Text</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="A fact or sedimented insight about the user"
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label className="block">
          <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Quality</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
          Tags (comma-separated)
        </span>
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() =>
            void onSubmit({
              text: text.trim(),
              source: "manual",
              subject: subject.trim() || null,
              quality,
              tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
            })
          }
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md bg-foreground text-background text-[10px] font-semibold px-2 py-1 disabled:opacity-40"
        >
          {mutating ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
          Create
        </button>
        <button
          onClick={onCancel}
          disabled={mutating}
          className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-white/60 text-foreground/60 text-[10px] font-medium px-2 py-1 hover:bg-foreground/5 disabled:opacity-40"
        >
          <X size={10} />
          Cancel
        </button>
      </div>
    </div>
  );
}
