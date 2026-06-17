import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, type PanInfo } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  GoalDetail,
  GoalsGrid,
  IdentitySummaryCard,
  MemoryPanel,
  ProfilePanel,
  WorkbenchTabButton,
  type ProfileGroupKey,
  Text,
} from "@pin-ai/ui-web";
import { useProfileMemories, useProfileSnapshot } from "@pin-ai/state";

/**
 * Mobile (iOS / 手机浏览器) MIRROR —— 移动布局 shell。数据走 @pin-ai/state 的
 * useProfileSnapshot / useProfileMemories；展示复用 @pin-ai/ui-web panel。
 * 交互与原 GoalsView 一致：Identity/Goals 横向 swipe pager + Identity 下
 * Profile/Memory sub-tab 二选一；goal 详情底部 Drawer。tab / openGroups /
 * expandedGoal 是 ephemeral UI state，留这层。
 */

// Identity / Goals 两个 pane 并排在 track 上，横向 swipe 切换。
const TOP_TABS = ["identity", "goals"] as const;
/** 横向 drag 跨过视口宽的这个比例、或超过这个速度，松手即切下/上一个 tab。 */
const TAB_COMMIT_FRACTION = 0.3;
const TAB_COMMIT_VELOCITY_PX_S = 300;

const sectionMotion = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24 },
};

export default function MirrorMobile() {
  const { t } = useTranslation("profile");
  const { profile, activeGoals, loading, error } = useProfileSnapshot();
  const memory = useProfileMemories();

  const [activeTab, setActiveTab] = useState<(typeof TOP_TABS)[number]>("identity");
  const [identitySubTab, setIdentitySubTab] = useState<"profile" | "memory">("profile");
  const [openGroups, setOpenGroups] = useState<Record<ProfileGroupKey, boolean>>({
    facts: false,
    preferences: false,
    constraints: false,
    metadata: false,
  });
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  // 横向 carousel：两个 pane 并排在 track 上。trackX(px) 是 track 实时偏移
  // ——拖动时跟手，松手 spring 到 active pane。pagerWidth 是一个 pane 的宽度
  // （= viewport），从 DOM 量，drag 数学才是真实像素。
  const trackX = useMotionValue(0);
  const pagerRef = useRef<HTMLDivElement>(null);
  const [pagerWidth, setPagerWidth] = useState(0);

  const toggleGroup = (group: ProfileGroupKey) =>
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const selectedGoal = expandedGoal
    ? activeGoals.find((goal) => goal.key === expandedGoal) ?? null
    : null;

  // 量一个 pane 的宽度（carousel viewport），resize 时保持最新，drag 距离与
  // snap 目标才是真实像素。
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const measure = () => setPagerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // [loading]：首挂时 pager 还是 loading spinner（ref 为 null），loading
    // 翻 false 后重量一次拿到真实宽度。
  }, [loading]);

  // tab 变化（pill 点击）或视口（重）量时把 track snap 到 active pane。拖动中
  // framer 实时驱动 trackX。
  useEffect(() => {
    const width = pagerRef.current?.clientWidth ?? pagerWidth;
    const controls = animate(trackX, -TOP_TABS.indexOf(activeTab) * width, {
      type: "spring",
      stiffness: 400,
      damping: 40,
    });
    return () => controls.stop();
  }, [activeTab, pagerWidth, trackX]);

  // 松手：drag 跨过距离/速度阈值就切下/上一个 pane，否则 spring 回当前。
  const settleDrag = (info: PanInfo) => {
    const width = pagerRef.current?.clientWidth || pagerWidth || 1;
    const cur = TOP_TABS.indexOf(activeTab);
    let target = cur;
    if (info.offset.x < -width * TAB_COMMIT_FRACTION || info.velocity.x < -TAB_COMMIT_VELOCITY_PX_S) {
      target = Math.min(cur + 1, TOP_TABS.length - 1);
    } else if (info.offset.x > width * TAB_COMMIT_FRACTION || info.velocity.x > TAB_COMMIT_VELOCITY_PX_S) {
      target = Math.max(cur - 1, 0);
    }
    if (target === cur) {
      animate(trackX, -cur * width, { type: "spring", stiffness: 400, damping: 40 });
    } else {
      setActiveTab(TOP_TABS[target]); // 上面的 effect 会 spring track
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col px-4"
      style={{ paddingTop: "var(--constellation-header-top, 0.75rem)" }}
    >
      {/* Page header */}
      <div className="mb-6 pr-20">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t("goalsView.title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("goalsView.subtitle")}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-14">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <Text variant="bodySm" className="text-foreground/40">{t("goalsView.loadingSnapshot")}</Text>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {error && (
            <motion.section {...sectionMotion} className="glass-card-strong mb-4 p-4">
              <p className="text-sm font-medium text-rose-500">{t("goalsView.refreshError")}</p>
              <p className="mt-1 text-xs leading-5 text-foreground/55">{error}</p>
            </motion.section>
          )}

          {/* Identity / Goals pill switcher */}
          <div
            className="shrink-0 flex items-center gap-1 p-1 rounded-full"
            style={{
              background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.7) 0%, hsla(0, 0%, 100%, 0.5) 100%)",
              backdropFilter: "blur(20px) saturate(1.4)",
              WebkitBackdropFilter: "blur(20px) saturate(1.4)",
              border: "1px solid hsla(0, 0%, 100%, 0.5)",
            }}
          >
            {TOP_TABS.map((tab) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-full transition-colors ${
                    isActive ? "bg-foreground text-background" : "text-foreground/55 hover:text-foreground/80"
                  }`}
                >
                  {t(`goalsView.tabs.${tab}`)}
                </button>
              );
            })}
          </div>

          {/* 跟手横向 carousel：两个 tab 并排挂在 track 上，横向 drag 跟手移动
              （纵向走原生滚动 via touch-action: pan-y），松手 spring 到最近 pane。 */}
          <div ref={pagerRef} className="relative mt-4 min-h-0 flex-1 overflow-hidden">
            <motion.div
              className="flex h-full"
              style={{ x: trackX, touchAction: "pan-y" }}
              drag="x"
              dragDirectionLock
              dragConstraints={{ left: -pagerWidth * (TOP_TABS.length - 1), right: 0 }}
              dragElastic={0.06}
              onDragEnd={(_, info) => settleDrag(info)}
            >
              {/* Identity pane */}
              <div
                className="h-full w-full shrink-0 space-y-4 overflow-y-auto overscroll-contain pb-2"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                <IdentitySummaryCard profile={profile} />

                {/* Profile / Memory sub-tab（移动端二选一；桌面并排） */}
                <div className="grid grid-cols-2 gap-2.5">
                  <WorkbenchTabButton
                    active={identitySubTab === "profile"}
                    label={t("goalsView.subTabs.profile")}
                    value={profile ? t("goalsView.subTabs.profile") : t("goalsView.subTabs.empty")}
                    onClick={() => setIdentitySubTab("profile")}
                  />
                  <WorkbenchTabButton
                    active={identitySubTab === "memory"}
                    label={t("goalsView.subTabs.memory")}
                    value={String(memory.total)}
                    onClick={() => setIdentitySubTab("memory")}
                  />
                </div>

                {identitySubTab === "profile" && (
                  <motion.section {...sectionMotion} className="glass-card-strong p-4">
                    <ProfilePanel profile={profile} openGroups={openGroups} onToggleGroup={toggleGroup} />
                  </motion.section>
                )}

                {identitySubTab === "memory" && (
                  <motion.section {...sectionMotion} className="glass-card-strong p-4">
                    <MemoryPanel
                      memories={memory.memories}
                      total={memory.total}
                      hasMore={memory.hasMore}
                      loadingMore={memory.loadingMore}
                      onLoadMore={memory.loadMore}
                    />
                  </motion.section>
                )}
              </div>

              {/* Goals pane */}
              <div
                className="h-full w-full shrink-0 overflow-y-auto overscroll-contain pb-2"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                <GoalsGrid goals={activeGoals} onOpen={setExpandedGoal} />
              </div>
            </motion.div>
          </div>
        </div>
      )}

      {/* 手机：goal 详情走底部 Drawer（detailLayout="drawer" 强制） */}
      <GoalDetail goal={selectedGoal} detailLayout="drawer" onClose={() => setExpandedGoal(null)} />
    </div>
  );
}
