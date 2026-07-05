/**
 * Mirror —— 共享展示层（React DOM，web 双端 apps/web + proactive 复用；RN 用
 * 不了这层，写自己的 UI，只共享 @pin-ai/state 的数据 hook）。
 *
 * Lifelong-memory（S3）：老 profile/memory/goals 结构化模型退役，Mirror 改为
 * 直接渲染 L2 画像 markdown。数据走 @pin-ai/state 的 usePortrait（六段 slot）；
 * Identity tab 渲染 USER + MEMORY，Goals tab 渲染 GOALS。每段 content 是
 * `§`-分隔的 entry block（见 core splitPortraitEntries），逐 entry 用共享的
 * MarkdownContent 渲染。ephemeral UI state（tab）留各 app 的 layout shell
 * （apps/web MirrorDesktop、proactive MirrorMobile）。
 */
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { splitPortraitEntries } from "@pin-ai/core";
import MarkdownContent from "../chat/conversation/MarkdownContent";
import { Text } from "../primitives/Text";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const sectionMotion = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24 },
};

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-foreground/10 bg-foreground/[0.03] px-4 py-5 text-center">
      <p className="text-sm font-medium text-foreground/70">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground/45">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portrait section — renders one markdown slot as a list of entry cards
// ---------------------------------------------------------------------------

/** One portrait entry — a `§`-delimited block rendered as markdown. */
function PortraitEntryCard({ entry }: { entry: string }) {
  return (
    <div className="glass-card p-4">
      <MarkdownContent text={entry} />
    </div>
  );
}

/**
 * A titled portrait section: header (title + description + entry count) over a
 * list of entry cards, or an empty state when the slot has no content.
 * `content` is the raw slot markdown; we split it into `§` entries here.
 */
export function PortraitSection({
  title,
  description,
  content,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  content: string | undefined;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const entries = splitPortraitEntries(content);
  return (
    <motion.section {...sectionMotion}>
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <Text variant="micro" weight="medium" className="rounded-full bg-foreground/5 px-2 py-0.5 text-foreground/45">
            {entries.length}
          </Text>
        </div>
        <Text variant="caption" className="block mt-1 leading-5 text-foreground/42">
          {description}
        </Text>
      </div>

      {entries.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="space-y-2.5">
          {entries.map((entry, i) => (
            <PortraitEntryCard key={i} entry={entry} />
          ))}
        </div>
      )}
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Identity / Goals — slot-backed panels the shells compose
// ---------------------------------------------------------------------------

/** Identity tab body: USER portrait + MEMORY portrait, stacked. */
export function IdentityPanel({ slots }: { slots: Record<string, string> }) {
  const { t } = useTranslation("profile");
  return (
    <div className="space-y-5">
      <div className="glass-card-strong p-4">
        <PortraitSection
          title={t("portrait.user.title")}
          description={t("portrait.user.description")}
          content={slots.USER}
          emptyTitle={t("portrait.user.emptyTitle")}
          emptyDescription={t("portrait.user.emptyDescription")}
        />
      </div>
      <div className="glass-card-strong p-4">
        <PortraitSection
          title={t("portrait.memory.title")}
          description={t("portrait.memory.description")}
          content={slots.MEMORY}
          emptyTitle={t("portrait.memory.emptyTitle")}
          emptyDescription={t("portrait.memory.emptyDescription")}
        />
      </div>
    </div>
  );
}

/** Goals tab body: GOALS portrait entries. */
export function GoalsPanel({ slots }: { slots: Record<string, string> }) {
  const { t } = useTranslation("profile");
  return (
    <div className="glass-card-strong p-4">
      <PortraitSection
        title={t("portrait.goals.title")}
        description={t("portrait.goals.description")}
        content={slots.GOALS}
        emptyTitle={t("portrait.goals.emptyTitle")}
        emptyDescription={t("portrait.goals.emptyDescription")}
      />
    </div>
  );
}
