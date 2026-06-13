/**
 * SkillsPanel — debug-panel card for managing v3 `skill_index` rows.
 *
 * Lists skills by status (enabled / disabled / archived), supports inline
 * edit of title / description / triggers / body, status transitions, and
 * archive-based soft delete. "New" opens an inline form that calls
 * POST /skills with source='manual'.
 *
 * Matches the visual language of CrystallizePanel — the same compact sizing
 * and Tailwind tokens.
 */
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Archive,
  Save,
  X,
} from "lucide-react";
import { useSkills } from "@pin-ai/state";
import { fetchSkill, type Skill, type SkillStatus } from "@pin-ai/core";
import { cn } from "../lib/utils";

interface SkillsPanelProps {
  enabled: boolean;
}

const STATUS_TABS: Array<{ key: SkillStatus; label: string }> = [
  { key: "enabled", label: "Enabled" },
  { key: "disabled", label: "Disabled" },
  { key: "archived", label: "Archived" },
];

const STATUS_STYLES: Record<SkillStatus, string> = {
  enabled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  disabled: "bg-amber-50 text-amber-700 border-amber-200",
  archived: "bg-foreground/5 text-foreground/50 border-foreground/10",
};

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

export default function SkillsPanel({ enabled }: SkillsPanelProps) {
  const { skills, loading, mutating, error, filter, setFilter, refetch, create, update, archive } =
    useSkills(enabled);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Debounce client-side filter string.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilter({ ...filter, q: query.trim() || undefined });
    }, 200);
    return () => clearTimeout(id);
    // 依赖刻意只挂 query：debounce 仅跟搜索词变化，filter 自身变化不重启计时器
    // （本仓 lint 未启 react-hooks 规则，注释留意图）。
  }, [query]);

  const status = filter.status ?? "enabled";
  const setStatus = (next: SkillStatus) => setFilter({ ...filter, status: next });

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <BookOpen size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">Skills</span>
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

      {/* Search */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search title / description / trigger"
        className="w-full rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 mb-2"
      />

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
            <CreateSkillForm
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
        {skills.length === 0 && !loading && (
          <div className="text-[10px] text-foreground/40 py-3 text-center">
            No {status} skills.
          </div>
        )}
        {skills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            expanded={expandedId === skill.id}
            onToggle={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
            mutating={mutating}
            onUpdate={(patch) => update(skill.id, patch)}
            onArchive={() => archive(skill.id)}
          />
        ))}
      </div>

      {error && <p className="mt-2 text-[10px] text-red-500 leading-snug">{error}</p>}
    </div>
  );
}

interface SkillRowProps {
  skill: Skill;
  expanded: boolean;
  mutating: boolean;
  onToggle: () => void;
  onUpdate: (patch: Parameters<ReturnType<typeof useSkills>["update"]>[1]) => Promise<Skill | null>;
  onArchive: () => Promise<boolean>;
}

function SkillRow({ skill, expanded, mutating, onToggle, onUpdate, onArchive }: SkillRowProps) {
  const [title, setTitle] = useState(skill.title);
  const [description, setDescription] = useState(skill.description ?? "");
  const [triggersText, setTriggersText] = useState(skill.triggers.join("\n"));
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  useEffect(() => {
    setTitle(skill.title);
    setDescription(skill.description ?? "");
    setTriggersText(skill.triggers.join("\n"));
  }, [skill.title, skill.description, skill.triggers]);

  useEffect(() => {
    if (!expanded) return;
    if (body !== null) return;
    setLoadingBody(true);
    fetchSkill(skill.id)
      .then((res) => setBody(res.skill.body ?? ""))
      .catch(() => setBody(""))
      .finally(() => setLoadingBody(false));
  }, [expanded, skill.id, body]);

  const dirty = useMemo(
    () =>
      title !== skill.title
      || (description || null) !== (skill.description ?? null)
      || triggersText.split("\n").map((t) => t.trim()).filter(Boolean).join("|")
        !== skill.triggers.join("|")
      || (body !== null && body !== (skill.body ?? body)),
    [title, description, triggersText, body, skill],
  );

  const save = async () => {
    const triggers = triggersText
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    await onUpdate({
      title: title.trim() || skill.title,
      description: description.trim() ? description : null,
      triggers,
      ...(body !== null ? { body } : {}),
    });
  };

  const toggleStatus = async () => {
    const next = skill.status === "enabled" ? "disabled" : "enabled";
    await onUpdate({ status: next });
  };

  return (
    <div className="rounded-lg border border-foreground/10 bg-white/50">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-foreground/5 transition-colors"
      >
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            STATUS_STYLES[skill.status],
          )}
        >
          {skill.status}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-foreground truncate">{skill.title}</div>
          {skill.description && (
            <div className="text-[10px] text-foreground/50 truncate">{skill.description}</div>
          )}
        </div>
        <div className="shrink-0 text-[9px] text-foreground/40 tabular-nums">
          r{skill.revision} · {relativeTime(skill.updated_at)}
        </div>
        <ChevronDown
          size={11}
          strokeWidth={1.5}
          className={cn("shrink-0 text-foreground/30 transition-transform", expanded && "rotate-180")}
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
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Title</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              <label className="block">
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Description</span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="optional"
                  className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              <label className="block">
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
                  Triggers (one per line)
                </span>
                <textarea
                  value={triggersText}
                  onChange={(e) => setTriggersText(e.target.value)}
                  rows={3}
                  className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              <label className="block">
                <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
                  Body (SKILL.md)
                </span>
                {loadingBody && body === null ? (
                  <div className="text-[10px] text-foreground/40 py-2">Loading body…</div>
                ) : (
                  <textarea
                    value={body ?? ""}
                    onChange={(e) => setBody(e.target.value)}
                    rows={8}
                    className="w-full mt-0.5 rounded-md bg-white/60 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                )}
              </label>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => void save()}
                  disabled={!dirty || mutating}
                  className="inline-flex items-center gap-1 rounded-md bg-foreground text-background text-[10px] font-semibold px-2 py-1 disabled:opacity-40"
                >
                  {mutating ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                  Save
                </button>
                {skill.status !== "archived" && (
                  <button
                    onClick={() => void toggleStatus()}
                    disabled={mutating}
                    className="rounded-md border border-foreground/10 bg-white/60 text-foreground/70 text-[10px] font-medium px-2 py-1 hover:bg-foreground/5 disabled:opacity-40"
                  >
                    {skill.status === "enabled" ? "Disable" : "Enable"}
                  </button>
                )}
                {skill.status !== "archived" && (
                  <button
                    onClick={() => void onArchive()}
                    disabled={mutating}
                    className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-white/60 text-foreground/70 text-[10px] font-medium px-2 py-1 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-40"
                  >
                    <Archive size={10} />
                    Archive
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface CreateSkillFormProps {
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; body: string; description?: string | null; triggers?: string[] }) => Promise<void>;
}

function CreateSkillForm({ mutating, onCancel, onSubmit }: CreateSkillFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [triggersText, setTriggersText] = useState("");
  const [body, setBody] = useState("");

  const disabled = !title.trim() || !body.trim() || mutating;

  return (
    <div className="rounded-lg border border-foreground/10 bg-white/70 p-2.5 space-y-2">
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Description</span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">
          Triggers (one per line)
        </span>
        <textarea
          value={triggersText}
          onChange={(e) => setTriggersText(e.target.value)}
          rows={2}
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <label className="block">
        <span className="text-[9px] font-medium text-foreground/40 uppercase tracking-wider">Body (SKILL.md)</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="## When to use..."
          className="w-full mt-0.5 rounded-md bg-white/80 border border-foreground/10 px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
      </label>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() =>
            void onSubmit({
              title: title.trim(),
              body,
              description: description.trim() ? description : null,
              triggers: triggersText.split("\n").map((t) => t.trim()).filter(Boolean),
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
