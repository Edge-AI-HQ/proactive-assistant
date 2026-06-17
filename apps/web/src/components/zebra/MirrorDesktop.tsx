import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  GoalDetail,
  GoalsGrid,
  IdentitySummaryCard,
  MemoryPanel,
  ProfilePanel,
  type ProfileGroupKey,
  Text,
} from "@pin-ai/ui-web";
import { useProfileMemories, useProfileSnapshot } from "@pin-ai/state";

/**
 * Desktop (zebra) MIRROR —— 桌面布局 shell。数据走 @pin-ai/state 的
 * useProfileSnapshot / useProfileMemories；展示复用 @pin-ai/ui-web 的共享
 * panel。桌面相对移动端的赢点：Identity 下 Profile | Memory **并排两栏**
 * （不再 sub-tab 二选一），标题 + Identity/Goals pill 同一行，内容居中限宽。
 * tab / openGroups / expandedGoal 是 ephemeral UI state，留在这层。
 */
const TABS = ["identity", "goals"] as const;

export default function MirrorDesktop() {
  const { t } = useTranslation("profile");
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>("identity");
  const { profile, activeGoals, loading, error } = useProfileSnapshot();
  // Memory only renders inside the Identity tab — skip the fetch on Goals.
  const memory = useProfileMemories(activeTab === "identity");
  const [openGroups, setOpenGroups] = useState<Record<ProfileGroupKey, boolean>>({
    facts: true,
    preferences: false,
    constraints: false,
    metadata: false,
  });
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  const toggleGroup = (group: ProfileGroupKey) =>
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const selectedGoal = expandedGoal
    ? activeGoals.find((goal) => goal.key === expandedGoal) ?? null
    : null;

  return (
    <div className="h-full overflow-y-auto px-8 pt-10 pb-12">
      <div className="max-w-5xl mx-auto">
        {/* Header + Identity/Goals pill on one row */}
        <div className="flex items-end justify-between gap-6 mb-5">
          <div>
            <Text as="h1" variant="title" weight="semibold" className="tracking-tight leading-tight">
              {t("goalsView.title")}
            </Text>
            <Text variant="caption" className="block mt-1 text-muted-foreground">
              {t("goalsView.subtitle")}
            </Text>
          </div>
          <div
            className="flex items-center gap-1 p-1 rounded-full w-[260px] shrink-0"
            style={{
              background: "linear-gradient(180deg, hsl(0 0% 100% / 0.7) 0%, hsl(0 0% 100% / 0.5) 100%)",
              backdropFilter: "blur(20px) saturate(1.4)",
              WebkitBackdropFilter: "blur(20px) saturate(1.4)",
              border: "1px solid hsl(0 0% 100% / 0.5)",
              boxShadow: "0 4px 16px hsl(0 0% 0% / 0.04)",
            }}
          >
            {TABS.map((tab) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2 rounded-full text-sm font-semibold transition-all ${
                    active ? "bg-foreground text-background shadow-sm" : "text-foreground/45 hover:text-foreground/70"
                  }`}
                >
                  {t(`goalsView.tabs.${tab}`)}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div className="glass-card-strong mb-5 p-4">
            <p className="text-sm font-medium text-rose-500">{t("goalsView.refreshError")}</p>
            <p className="mt-1 text-xs leading-5 text-foreground/55">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16">
            <Loader2 size={16} className="animate-spin text-foreground/40" />
            <Text variant="bodySm" className="text-foreground/40">{t("goalsView.loadingSnapshot")}</Text>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            >
              {activeTab === "identity" ? (
                <>
                  <div className="mb-5">
                    <IdentitySummaryCard profile={profile} />
                  </div>
                  {/* Profile | Memory side by side — the desktop win (no sub-tab). */}
                  <div className="grid grid-cols-2 gap-5 items-start">
                    <div className="glass-card-strong p-4">
                      <ProfilePanel profile={profile} openGroups={openGroups} onToggleGroup={toggleGroup} />
                    </div>
                    <div className="glass-card-strong p-4">
                      {memory.loading && memory.memories.length === 0 ? (
                        <div className="flex items-center justify-center gap-2 py-10">
                          <Loader2 size={14} className="animate-spin text-foreground/40" />
                          <Text variant="bodySm" className="text-foreground/40">{t("goalsView.loadingSnapshot")}</Text>
                        </div>
                      ) : (
                        <MemoryPanel
                          memories={memory.memories}
                          total={memory.total}
                          hasMore={memory.hasMore}
                          loadingMore={memory.loadingMore}
                          onLoadMore={memory.loadMore}
                        />
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <GoalsGrid goals={activeGoals} onOpen={setExpandedGoal} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {/* Wide-screen goal detail = centered glass popup (GoalDetail picks it). */}
      <GoalDetail goal={selectedGoal} onClose={() => setExpandedGoal(null)} />
    </div>
  );
}
