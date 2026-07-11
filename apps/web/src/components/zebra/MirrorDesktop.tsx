import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GoalsPanel, PortraitSection, Text } from "@/ui-web";
import { usePortrait } from "@pin-ai/state";

/**
 * Desktop (zebra) MIRROR —— 桌面布局 shell。数据走 @pin-ai/state 的 usePortrait
 * （L2 画像六段 markdown）；展示复用 @/ui-web 的共享 panel。Identity tab
 * 渲染 USER + MEMORY 两段画像，桌面相对移动端的赢点：两段 **并排两栏**（不再上下
 * 堆叠）；Goals tab 渲染 GOALS。tab 是 ephemeral UI state，留在这层。
 */
const TABS = ["identity", "goals"] as const;

export default function MirrorDesktop() {
  const { t } = useTranslation("profile");
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>("identity");
  const { slots, loading, error } = usePortrait();

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
                /* USER | MEMORY side by side — the desktop win. */
                <div className="grid grid-cols-2 gap-5 items-start">
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
              ) : (
                <GoalsPanel slots={slots} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
