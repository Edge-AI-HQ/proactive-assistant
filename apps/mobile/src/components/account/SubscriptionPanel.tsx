/**
 * Subscription 子页 —— web `ui-web/account/SubscriptionPanel.tsx` 的 RN 对应物。
 * 真实 Stripe 状态（/api/payment/subscription）+ 计划切换（createCheckout：新订阅
 * 跳 Checkout、换档 schedule 到下个续费）+ 一次性加购（createTopup）+ 支付方式 +
 * 账单历史（Stripe Customer Portal 承载卡片更新/发票下载，不自建）+ 取消
 * （cancel_at_period_end，两击确认）。数据函数全走 @pin-ai/core payment 域（零重写）。
 *
 * 平台介质差异（dev = Capacitor WKWebView，RN 无页面导航）：
 * - dev `window.location.href = checkoutUrl` 整页跳 Stripe、付完回跳 successUrl；
 *   RN 用 expo-web-browser 开 in-app browser（SFSafariViewController，iOS 上
 *   Stripe Checkout 的标准宿主），successUrl/cancelUrl 不传 → 走后端
 *   PAYMENT_PUBLIC_BASE_URL 兜底成功页；用户关掉浏览器后静默 refresh ——
 *   reconcile 直接从 Stripe 拉 canonical 状态，webhook 迟到也能收敛
 *   （web 本就靠同一条 reconcile 兜底本地无 webhook 的场景）。
 * - dev `window.open(portalUrl)` 后无法感知关闭；RN openBrowserAsync 关闭即
 *   resolve → 顺手静默刷新（Portal 里可能改了卡/取消了订阅）。
 * - 发票行 `<a href>` → 同样开 in-app browser。
 * 文案走 i18n（account ns 的 subscription.* / plans.*，8 语言）—— dev ui-web
 * 组件本身还硬编码英文，这里是对 dev 的有意升级（用户要求整屏可翻译）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View, type DimensionValue } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import * as WebBrowser from "expo-web-browser";
import { AlertTriangle, Calendar, Check, CreditCard, Receipt, Sparkles } from "lucide-react-native";
import {
  cancelCurrentSubscription,
  createCheckout,
  createTopup,
  getCurrentSubscription,
  getCustomerPortalUrl,
  getUsage,
  listPaymentHistory,
  listPaymentMethods,
  reconcileSubscription,
  type PaymentHistoryEntry,
  type PaymentMethodEntry,
  type PlanCode,
  type SubscriptionState,
  type UsageInfo,
} from "@pin-ai/core";

import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";
import { PLANS, planCredits, planName, planPerks } from "./plans";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "hsl(220, 30%, 96%)";
// 品红（当前计划卡）/ 紫（Current 徽章、pending 切换）/ 破坏红（取消）。
const PINK = "hsl(304, 75%, 63%)";
const pink = (a: number) => `hsla(304, 75%, 63%, ${a})`;
const PURPLE = "hsl(292, 78%, 63%)";
const purple = (a: number) => `hsla(292, 78%, 63%, ${a})`;
const red = (a: number) => `hsla(0, 72%, 60%, ${a})`;
const RED_TEXT = "hsl(0, 72%, 45%)";
const RED_ICON = "hsl(0, 72%, 50%)";
const MONO = { fontVariant: ["tabular-nums" as const] };

// Module-level cache so SubscriptionPanel renders cached data on
// re-mount (tab switches, after action) instead of flashing a spinner.
// Survives across React mounts but not across app restarts. Populated by
// refresh() and never invalidated (last write wins; reconcile is the
// silent refresh path).
const subscriptionPanelCache: {
  sub: SubscriptionState | null;
  usage: UsageInfo | null;
  paymentMethods: PaymentMethodEntry[];
  paymentHistory: PaymentHistoryEntry[];
  primed: boolean;
} = {
  sub: null,
  usage: null,
  paymentMethods: [],
  paymentHistory: [],
  primed: false,
};

const RECONCILE_TIMEOUT_MS = 1500;

function formatCredits(credits: number): string {
  return Math.max(0, Math.round(credits)).toLocaleString();
}

function formatBudgetUsdFromCredits(credits: number): string {
  const dollars = Math.max(0, Math.round(credits)) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function resolvePlanAllowanceCredits(usage: UsageInfo | null): number {
  if (typeof usage?.planAllowanceCredits === "number") {
    return Math.max(0, Math.round(usage.planAllowanceCredits));
  }
  if (!usage) return 0;
  return Math.max(
    0,
    Math.round(usage.maxBudgetUsd * 100) - Math.round(usage.topupCreditsAvailable ?? 0),
  );
}

function optionalWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function formatPeriodDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** micro(10)/700 大写宽字距小徽章（status / Current / Default）。 */
function MicroBadge({ text, bg: badgeBg, color }: { text: string; bg: string; color: string }) {
  return (
    <View style={{ borderRadius: 18, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: badgeBg }}>
      <Text
        style={{
          fontFamily: "Inter_700Bold",
          fontSize: 10,
          lineHeight: 14,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/** micro(10)/600 大写 tracking-[0.12em] 区块小标（Change plan / Payment method…）。 */
function MicroLabel({ text, tracking = 1.2, color = fg(0.45) }: { text: string; tracking?: number; color?: string }) {
  return (
    <Text
      style={{
        fontFamily: "Inter_600SemiBold",
        fontSize: 10,
        lineHeight: 14,
        letterSpacing: tracking,
        textTransform: "uppercase",
        color,
      }}
    >
      {text}
    </Text>
  );
}

/** Plan credits 进度条 —— web `transition-all duration-500` 的宽度动画（首帧直落不动画）。 */
function PlanCreditsBar({ pct, color }: { pct: number; color: string }) {
  const [trackW, setTrackW] = useState(0);
  const w = useSharedValue(0);
  const mounted = useRef(false);
  useEffect(() => {
    if (trackW <= 0) return;
    const target = (Math.min(100, Math.max(0, pct)) / 100) * trackW;
    if (!mounted.current) {
      mounted.current = true;
      w.value = target;
    } else {
      w.value = withTiming(target, { duration: 500 });
    }
  }, [pct, trackW, w]);
  const fillStyle = useAnimatedStyle(() => ({ width: w.value }));
  return (
    <View
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      style={{ height: 6, borderRadius: 999, backgroundColor: fg(0.08), overflow: "hidden" }}
    >
      <Animated.View style={[{ height: "100%", borderRadius: 999, backgroundColor: color }, fillStyle]} />
    </View>
  );
}

/** 灰色占位条。骨架屏用，不出现任何"loading"字样。 */
function SkeletonBar({ w, h = 12, mt = 0, r = 6 }: { w: DimensionValue; h?: number; mt?: number; r?: number }) {
  return <View style={{ width: w, height: h, marginTop: mt, borderRadius: r, backgroundColor: fg(0.06) }} />;
}

/**
 * 冷启动骨架屏——替代原来的 "Loading…" 文案（用户要求任何页面不出现 loading 字样）。
 * 结构对齐加载完成后的顶部（当前计划卡 + 两个快捷卡），把内容替换时的跳动降到最小。
 * 只在本 session 首次进入、模块缓存未 primed 时出现一瞬；再次进入走缓存、零骨架。
 */
function SubscriptionSkeleton() {
  return (
    <View>
      <GlassCard strong className="mb-3 p-4">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: fg(0.06) }} />
          <View style={{ flex: 1 }}>
            <SkeletonBar w="45%" h={16} />
            <SkeletonBar w="60%" h={11} mt={8} />
          </View>
        </View>
        <SkeletonBar w="100%" h={6} r={999} />
      </GlassCard>
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
        {[0, 1].map((i) => (
          <View key={i} style={{ flex: 1 }}>
            <GlassCard strong className="p-3">
              <SkeletonBar w="50%" h={10} />
              <SkeletonBar w="70%" h={13} mt={6} />
            </GlassCard>
          </View>
        ))}
      </View>
    </View>
  );
}

export function SubscriptionPanel() {
  // account 为默认 ns（subscription.*/plans.* 免前缀）。
  const { t } = useTranslation("account");
  // Initial values come from the module cache: if the user has visited
  // this page before this session, we render those values instantly and
  // refresh silently in the background. First-ever mount has primed=false
  // so loading=true triggers the cold-start spinner once.
  const [sub, setSub] = useState<SubscriptionState | null>(subscriptionPanelCache.sub);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodEntry[]>(subscriptionPanelCache.paymentMethods);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryEntry[]>(subscriptionPanelCache.paymentHistory);
  const [usage, setUsage] = useState<UsageInfo | null>(subscriptionPanelCache.usage);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [loading, setLoading] = useState(!subscriptionPanelCache.primed);
  const [actionPending, setActionPending] = useState(false);
  const [pendingPlanCode, setPendingPlanCode] = useState<PlanCode | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [showTopup, setShowTopup] = useState(false);
  const [customTopup, setCustomTopup] = useState("");
  const [topupFocused, setTopupFocused] = useState(false);

  const refresh = useCallback(async (silent: boolean = false) => {
    try {
      // silent=true: keep current UI visible while we refetch in the
      // background (cache-first / stale-while-revalidate). Used when the
      // module cache is already primed, or after a user action where we
      // want the action's result to drive UI not a full reload spinner.
      if (!silent) setLoading(true);
      // Stripe webhook isn't forwarded in local dev → reconcile pulls
      // canonical state from Stripe + upserts pai_subscriptions. Silent
      // failure (reconcile is a "nice to have"; getCurrentSubscription
      // is the authoritative read below).
      let multipleActive = false;
      const r = await optionalWithTimeout(
        reconcileSubscription(),
        RECONCILE_TIMEOUT_MS,
      );
      // Only warn when 2+ subs are actually going to bill — a sub in
      // cancel_at_period_end will wind down on its own, not a duplicate.
      if (r && (r.activelyRenewing ?? r.totalActive ?? 0) > 1) multipleActive = true;
      const [s, pms, invs, u] = await Promise.all([
        getCurrentSubscription(),
        listPaymentMethods().catch(() => [] as PaymentMethodEntry[]),
        listPaymentHistory(12).catch(() => [] as PaymentHistoryEntry[]),
        getUsage().catch(() => null as UsageInfo | null),
      ]);
      // Write through to module cache so the next mount can render
      // instantly without re-fetching.
      setSub(s); subscriptionPanelCache.sub = s;
      setPaymentMethods(pms); subscriptionPanelCache.paymentMethods = pms;
      setPaymentHistory(invs); subscriptionPanelCache.paymentHistory = invs;
      setUsage(u); subscriptionPanelCache.usage = u;
      subscriptionPanelCache.primed = true;
      setError(null);
      if (multipleActive) {
        setActionToast(t("subscription.multipleActiveWarning"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscription.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // If the cache is already primed (user has visited this page during
    // this session), do a silent background refresh — no spinner. Cold
    // start (primed=false) shows the spinner exactly once.
    void refresh(subscriptionPanelCache.primed);
  }, [refresh]);

  const onSubscribeOrChange = async (planCode: PlanCode) => {
    if (actionPending) return;
    setActionPending(true);
    setPendingPlanCode(planCode);
    setActionToast(null);
    setError(null);
    try {
      // successUrl/cancelUrl 不传 → 后端 PAYMENT_PUBLIC_BASE_URL 兜底成功页
      // （RN 没有 window.location.origin 可回跳）。
      const r = await createCheckout(planCode);
      if (r.checkoutUrl) {
        // new subscription — Stripe Checkout in the in-app browser; the
        // promise resolves when the user closes it → silent refresh picks
        // up the paid state (reconcile covers webhook lag).
        setShowPlanPicker(false);
        await WebBrowser.openBrowserAsync(r.checkoutUrl);
        await refresh(true);
        return;
      }
      if (r.flow === "revoke") {
        // User clicked their current plan with a pending switch active —
        // backend cleared pending_plan_code and reset Stripe price.
        setActionToast(t("subscription.switchRevoked"));
      } else {
        // Switch (upgrade / downgrade / lateral): scheduled for next renewal,
        // no immediate charge. Plan card now shows a "→ Switching to X on
        // <date>" hint sourced from sub.pendingPlanCode.
        const matchedPlan = PLANS.find((p) => p.id === planCode);
        const newPlanName =
          (matchedPlan ? planName(matchedPlan.id) : null)
          ?? (planCode.charAt(0).toUpperCase() + planCode.slice(1));
        setActionToast(t("subscription.switchScheduled", { plan: newPlanName }));
      }
      setShowPlanPicker(false);  // collapse picker so user sees the new state
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscription.checkoutFailed"));
    } finally {
      setActionPending(false);
      setPendingPlanCode(null);
    }
  };

  const onTopup = async (amountCents: number) => {
    if (actionPending) return;
    setActionPending(true);
    setActionToast(null);
    setError(null);
    try {
      const r = await createTopup(amountCents);
      // Stripe Checkout (mode=payment) — credits land on the
      // checkout.session.completed webhook after the user pays; refresh
      // after the browser closes to pick up the new balance.
      await WebBrowser.openBrowserAsync(r.checkoutUrl);
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscription.topupFailed"));
    } finally {
      setActionPending(false);
    }
  };

  const onCustomTopup = () => {
    const dollars = Number(customTopup);
    if (!Number.isFinite(dollars) || dollars < 5 || dollars > 1000) {
      setError(t("subscription.topupAmountRange", { min: 5, max: 1000 }));
      return;
    }
    void onTopup(Math.round(dollars * 100));
  };

  const togglePlanPicker = () => {
    const next = !showPlanPicker;
    setShowPlanPicker(next);
    if (next) setShowTopup(false);
  };

  const toggleTopupPicker = () => {
    const next = !showTopup;
    setShowTopup(next);
    if (next) setShowPlanPicker(false);
  };

  const onManage = async () => {
    setActionPending(true);
    setError(null);
    try {
      const { portalUrl } = await getCustomerPortalUrl();
      // Portal 里可能更新了卡/取消了订阅 → 关掉浏览器后静默刷新。
      await WebBrowser.openBrowserAsync(portalUrl);
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscription.portalFailed"));
    } finally {
      setActionPending(false);
    }
  };

  const performCancel = async () => {
    setConfirmingCancel(false);
    setActionPending(true);
    setError(null);
    try {
      await cancelCurrentSubscription();
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("subscription.cancelFailed"));
    } finally {
      setActionPending(false);
    }
  };

  // Inline two-step confirm — replaces window.confirm() which can hang in
  // Capacitor / certain WebView contexts and leave actionPending pending
  // forever. The Cancel button toggles confirmingCancel, then a second
  // tap on the same button (now "Tap again to confirm") performs the cancel.
  const onCancel = () => {
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    void performCancel();
  };

  const openInvoice = (url: string) => {
    void WebBrowser.openBrowserAsync(url);
  };

  // planLabel: Free → subscription.planFree；付费档 → plans.<id>.name（已翻译）；
  // 未知 code 兜底首字母大写（防御性，dev 同款）。
  const planLabel = (() => {
    const code = sub?.planCode;
    if (!code || code === "free") return t("subscription.planFree");
    // 付费档 basic/pro/max 已覆盖 PlanCode 全部非 free 成员 → 直接取翻译档名。
    return planName(code);
  })();

  const periodEnd = sub?.currentPeriodEnd ? formatPeriodDate(sub.currentPeriodEnd) : null;

  const statusLabel = (() => {
    if (!sub) return t("subscription.statusFree");
    if (sub.planCode === "free") return t("subscription.statusFree");
    if (sub.status === "trialing") return t("subscription.statusTrial");
    if (sub.status === "active" && sub.cancelAtPeriodEnd) return t("subscription.statusCanceling");
    if (sub.status === "active") return t("subscription.statusActive");
    if (sub.status === "past_due") return t("subscription.statusPastDue");
    if (sub.status === "canceled") return t("subscription.statusCanceled");
    if (sub.status === "inactive") return t("subscription.statusFree");
    return sub.status;
  })();

  const isFree = !sub || sub.planCode == null || sub.planCode === "free";
  const currentPlanInfo = PLANS.find((p) => p.id === sub?.planCode);
  const currentFeatures = currentPlanInfo ? planPerks(currentPlanInfo.id) : [];
  const monthlyPlanCredits = resolvePlanAllowanceCredits(usage);
  const totalSpendCredits = Math.max(0, Math.round((usage?.spendUsd ?? 0) * 100));
  const planCreditsUsed = Math.min(totalSpendCredits, monthlyPlanCredits);
  const topupCreditsGranted = Math.max(
    0,
    Math.round(usage?.topupCreditsAvailable ?? 0),
  );
  const extraCreditsSpent = Math.max(0, totalSpendCredits - monthlyPlanCredits);
  const extraCreditsAvailable = Math.max(0, topupCreditsGranted - extraCreditsSpent);
  const planCreditsRemaining = Math.max(0, monthlyPlanCredits - planCreditsUsed);
  const totalCreditsAvailable = planCreditsRemaining + extraCreditsAvailable;
  const creditsAvailableLine = extraCreditsAvailable > 0
    ? t("subscription.extraCreditsInline", { count: formatCredits(extraCreditsAvailable) })
    : null;
  // " · " 分隔符是语言中性的排版标点，各语言复用（对齐 freePriceLine 的写法）。
  const withCreditsAvailable = (line: string) =>
    creditsAvailableLine ? `${line} · ${creditsAvailableLine}` : line;
  const priceLine = (() => {
    if (isFree) {
      const budget = monthlyPlanCredits > 0
        ? formatBudgetUsdFromCredits(monthlyPlanCredits)
        : "$5";
      return creditsAvailableLine
        ? `${t("subscription.monthlyBudget", { budget })} · ${creditsAvailableLine}`
        : t("subscription.monthlyBudgetUpgrade", { budget });
    }
    const head = currentPlanInfo?.price ? t("subscription.pricePerMonth", { price: currentPlanInfo.price }) : "—";
    if (sub.cancelAtPeriodEnd && periodEnd) return withCreditsAvailable(t("subscription.priceEnds", { price: head, date: periodEnd }));
    if (sub.status === "trialing" && periodEnd) return withCreditsAvailable(t("subscription.priceTrialEnds", { price: head, date: periodEnd }));
    if (periodEnd) return withCreditsAvailable(t("subscription.priceRenews", { price: head, date: periodEnd }));
    return withCreditsAvailable(head);
  })();
  const otherPlansLabel = (() => {
    if (isFree) return PLANS.map((p) => planName(p.id)).join(" / ");
    const others = PLANS.filter((p) => p.id !== sub?.planCode).map((p) => planName(p.id));
    return others.length > 0 ? others.join(" / ") : "—";
  })();

  const pendingPlanLine = sub?.pendingPlanCode
    ? (() => {
        const pending = PLANS.find((p) => p.id === sub.pendingPlanCode);
        const name = pending
          ? planName(pending.id)
          : sub.pendingPlanCode!.charAt(0).toUpperCase() + sub.pendingPlanCode!.slice(1);
        return periodEnd
          ? t("subscription.switchingToOn", { plan: name, date: periodEnd })
          : t("subscription.switchingTo", { plan: name });
      })()
    : null;

  return (
    <View>
      {loading && !sub ? <SubscriptionSkeleton /> : null}

      {error ? (
        <View
          style={{
            borderRadius: 12,
            borderWidth: 1,
            borderColor: red(0.25),
            backgroundColor: red(0.04),
            paddingHorizontal: 12,
            paddingVertical: 8,
            marginBottom: 12,
          }}
        >
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: RED_TEXT }}>
            {error}
          </Text>
        </View>
      ) : null}

      {!loading && sub ? (
        <View>
          {/* 1. Current plan — adapts to sub state. Features grid uses PLANS
              perks for active plan; hidden for Free. */}
          <GlassCard strong className="mb-3 p-4">
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  backgroundColor: pink(0.12),
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Sparkles size={16} strokeWidth={1.8} color={PINK} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 16, lineHeight: 24, color: fg() }}>
                    {planLabel}
                  </Text>
                  <MicroBadge text={statusLabel} bg={pink(0.1)} color={PINK} />
                </View>
                <Text style={{ marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>
                  {priceLine}
                </Text>
                {pendingPlanLine ? (
                  <Text style={{ marginTop: 2, fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: PURPLE }}>
                    {pendingPlanLine}
                  </Text>
                ) : null}
              </View>
            </View>
            {currentFeatures.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 4, paddingTop: 4 }}>
                {currentFeatures.map((f) => (
                  <View key={f} style={{ width: "50%", flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 12 }}>
                    <Check size={11} strokeWidth={2.5} color={PINK} />
                    <Text
                      numberOfLines={1}
                      style={{ flexShrink: 1, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.7) }}
                    >
                      {f}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Budget usage progress — product plan bucket + purchased top-up bucket. */}
            {usage && monthlyPlanCredits > 0 ? (() => {
              const pct = (planCreditsUsed / monthlyPlanCredits) * 100;
              const creditsExhausted = totalCreditsAvailable <= 0;
              const planUsageText = t("subscription.creditsUsed", {
                used: formatCredits(planCreditsUsed),
                total: formatCredits(monthlyPlanCredits),
              });
              const extraCreditsText = t("subscription.extraAvailable", { count: formatCredits(extraCreditsAvailable) });
              const barColor = creditsExhausted
                ? "hsl(0, 75%, 55%)"
                : pct >= 80
                  ? "hsl(40, 95%, 55%)"
                  : "hsl(150, 70%, 50%)";
              return (
                <View
                  style={
                    currentFeatures.length > 0
                      ? { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: fg(0.06) }
                      : { marginTop: 8 }
                  }
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <Text
                      style={{
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 11,
                        lineHeight: 15,
                        letterSpacing: 1.32,
                        textTransform: "uppercase",
                        color: fg(0.55),
                      }}
                    >
                      {t("subscription.planCreditsLabel")}
                    </Text>
                    <Text style={[{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg(0.85) }, MONO]}>
                      {planUsageText}
                      <Text style={{ color: fg(0.45) }}>{` (${Math.round(pct)}%)`}</Text>
                    </Text>
                  </View>
                  <PlanCreditsBar pct={pct} color={barColor} />
                  {topupCreditsGranted > 0 ? (
                    <View style={{ marginTop: 8, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <View>
                        <Text
                          style={{
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 11,
                            lineHeight: 15,
                            letterSpacing: 1.32,
                            textTransform: "uppercase",
                            color: fg(0.55),
                          }}
                        >
                          {t("subscription.extraCredits")}
                        </Text>
                        <Text style={{ marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                          {t("subscription.usedAfterPlanCredits")}
                        </Text>
                      </View>
                      <Text style={[{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg(0.85), textAlign: "right" }, MONO]}>
                        {extraCreditsText}
                      </Text>
                    </View>
                  ) : null}
                  {creditsExhausted ? (
                    <Text style={{ marginTop: 6, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: RED_TEXT }}>
                      {isFree
                        ? t("subscription.creditsExhaustedUpgrade")
                        : t("subscription.creditsExhaustedRenewal")}
                    </Text>
                  ) : null}
                </View>
              );
            })() : null}
          </GlassCard>

          {actionToast ? (
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: pink(0.25),
                backgroundColor: pink(0.05),
                paddingHorizontal: 12,
                paddingVertical: 8,
                marginBottom: 12,
              }}
            >
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.75) }}>
                {actionToast}
              </Text>
            </View>
          ) : null}

          {/* 2. Quick actions — Change plan expands the plan picker; Add credits
              expands the one-time top-up picker below. */}
          {/* Pressable 的 style 不渲染（项目坑）→ flex 由外层 View 承载。 */}
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Pressable onPress={togglePlanPicker}>
                <GlassCard strong className="p-3">
                  <View style={{ marginBottom: 2 }}>
                    <MicroLabel text={t("subscription.changePlan")} />
                  </View>
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }}>
                    {showPlanPicker ? t("subscription.hide") : otherPlansLabel}
                  </Text>
                </GlassCard>
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>
              <Pressable onPress={toggleTopupPicker}>
                <GlassCard strong className="p-3">
                  <View style={{ marginBottom: 2 }}>
                    <MicroLabel text={t("subscription.addCredits")} />
                  </View>
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }}>
                    {showTopup ? t("subscription.hide") : t("subscription.buyCredits")}
                  </Text>
                </GlassCard>
              </Pressable>
            </View>
          </View>

          {/* 2b. Top-up picker — one-time credit purchase via /api/payment/topup
              (Stripe Checkout mode=payment). Credits land on the
              checkout.session.completed webhook; balance updates after payment. */}
          {showTopup ? (
            <GlassCard strong className="mb-3 p-3" style={{ gap: 10 }}>
              <MicroLabel text={t("subscription.addCreditsOneTime")} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                {[2000, 5000, 10000].map((cents) => (
                  <View key={cents} style={{ flex: 1 }}>
                    <Pressable disabled={actionPending} onPress={() => void onTopup(cents)}>
                      <GlassCard strong className="p-2.5" style={{ alignItems: "center", opacity: actionPending ? 0.5 : 1 }}>
                        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }}>
                          {`$${cents / 100}`}
                        </Text>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                          {t("subscription.creditsShort", { count: cents.toLocaleString() })}
                        </Text>
                      </GlassCard>
                    </Pressable>
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: topupFocused ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.15)",
                    backgroundColor: "rgba(255,255,255,0.1)",
                    paddingLeft: 12,
                  }}
                >
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 20, color: fg(0.5) }}>$</Text>
                  <TextInput
                    keyboardType="decimal-pad"
                    placeholder={t("subscription.otherAmount")}
                    placeholderTextColor={fg(0.4)}
                    value={customTopup}
                    onChangeText={setCustomTopup}
                    onFocus={() => setTopupFocused(true)}
                    onBlur={() => setTopupFocused(false)}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      paddingLeft: 4,
                      paddingRight: 12,
                      fontFamily: "Inter_400Regular",
                      fontSize: 14,
                      color: fg(),
                    }}
                  />
                </View>
                <Pressable disabled={actionPending || !customTopup} onPress={onCustomTopup}>
                  <GlassCard
                    strong
                    className="px-4 py-2"
                    style={{ opacity: actionPending || !customTopup ? 0.5 : 1 }}
                  >
                    <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: fg() }}>
                      {t("subscription.buy")}
                    </Text>
                  </GlassCard>
                </Pressable>
              </View>
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                {t("subscription.topupNote")}
              </Text>
            </GlassCard>
          ) : null}

          {/* 2a. Plan picker — revealed when Change plan is tapped. Wires to
              /api/payment/create-checkout (handles new / upgrade / downgrade). */}
          {showPlanPicker ? (
            <View style={{ gap: 8, marginBottom: 20 }}>
              {PLANS.map((p) => {
                const isCurrent = p.id === sub.planCode;
                const isPending = pendingPlanCode === p.id;
                const disabled = actionPending || isCurrent;
                return (
                  <Pressable key={p.id} disabled={disabled} onPress={() => void onSubscribeOrChange(p.id)}>
                    <GlassCard strong className="p-4" style={{ opacity: isCurrent ? 0.6 : actionPending ? 0.6 : 1 }}>
                      {isCurrent ? (
                        // dev 给当前档的按钮加 borderColor 紫 0.45 —— GlassCard 边框在内部，
                        // 用一层描边 overlay 等价。
                        <View
                          pointerEvents="none"
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            borderRadius: 24,
                            borderWidth: 1,
                            borderColor: purple(0.45),
                          }}
                        />
                      ) : null}
                      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }}>
                          {planName(p.id)}
                        </Text>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.8) }}>
                          {t("subscription.priceMonthly", { price: p.price })}
                        </Text>
                        <View style={{ flex: 1 }} />
                        {isCurrent ? <MicroBadge text={t("subscription.current")} bg={purple(0.12)} color={PURPLE} /> : null}
                        {isPending ? <Spinner size={11} color={fg(0.55)} /> : null}
                      </View>
                      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>
                        {planCredits(p.id)}
                      </Text>
                    </GlassCard>
                  </Pressable>
                );
              })}
              <Text style={{ marginTop: 8, paddingHorizontal: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                {isFree
                  ? t("subscription.cardRequired")
                  : t("subscription.changesAtRenewal")}
              </Text>
            </View>
          ) : null}

          {/* 3. Payment method — real Stripe cards. Update opens Stripe Customer Portal. */}
          <GlassCard strong className="mb-3 p-4">
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <CreditCard size={13} strokeWidth={1.8} color={fg(0.55)} />
              <MicroLabel text={t("subscription.paymentMethod")} tracking={1.4} color={fg(0.55)} />
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => void onManage()} disabled={actionPending} hitSlop={8}>
                <Text
                  style={{
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 10,
                    lineHeight: 14,
                    color: fg(0.55),
                    opacity: actionPending ? 0.5 : 1,
                  }}
                >
                  {t("subscription.updateOnStripe")}
                </Text>
              </Pressable>
            </View>
            {paymentMethods.length === 0 ? (
              <Text style={{ paddingVertical: 4, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.55) }}>
                {isFree ? t("subscription.noCardOnFile") : t("subscription.noPaymentMethod")}
              </Text>
            ) : (
              <View style={{ gap: 8 }}>
                {paymentMethods.map((pm) => {
                  // Pick display shape per Stripe PaymentMethod type.
                  let chipLabel = "CARD";
                  let primary = t("subscription.genericPaymentMethod");
                  let secondary: string | null = null;
                  const checkoutOnly = pm.source === "checkout" || pm.isSaved === false;
                  if (pm.type === "card") {
                    chipLabel = (pm.brand ?? "card").toUpperCase().slice(0, 5);
                    primary = `•••• ${pm.last4 ?? "····"}`;
                    secondary = checkoutOnly
                      ? t("subscription.usedAtCheckout")
                      : (
                        pm.expMonth != null && pm.expYear != null
                          ? t("subscription.cardExpires", {
                              date: `${String(pm.expMonth).padStart(2, "0")} / ${String(pm.expYear).slice(-2)}`,
                            })
                          : null
                      );
                  } else if (pm.type === "link") {
                    chipLabel = "LINK";
                    primary = "Stripe Link";  // 品牌名保留原文
                    secondary = pm.linkEmail ?? null;
                  } else if (pm.type === "apple_pay") {
                    chipLabel = "";
                    primary = "Apple Pay";  // 品牌名保留原文
                  } else if (pm.type === "google_pay") {
                    chipLabel = "G PAY";
                    primary = "Google Pay";  // 品牌名保留原文
                  } else if (pm.type === "us_bank_account") {
                    chipLabel = "BANK";
                    primary = pm.last4
                      ? t("subscription.bankWithLast4", { last4: pm.last4 })
                      : t("subscription.bankAccount");
                  } else {
                    chipLabel = pm.type.toUpperCase().slice(0, 5);
                    primary = pm.type;
                  }
                  if (checkoutOnly && !secondary) {
                    secondary = t("subscription.usedAtCheckout");
                  }
                  return (
                    <View key={pm.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                      <View
                        style={{
                          width: 40,
                          height: 28,
                          borderRadius: 18,
                          backgroundColor: fg(0.85),
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: "Inter_700Bold",
                            fontSize: 10,
                            lineHeight: 14,
                            letterSpacing: 0.5,
                            color: BG,
                          }}
                        >
                          {chipLabel}
                        </Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <Text
                            numberOfLines={1}
                            style={{ flexShrink: 1, fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }}
                          >
                            {primary}
                          </Text>
                          {pm.isDefault ? <MicroBadge text={t("subscription.defaultBadge")} bg={purple(0.12)} color={PURPLE} /> : null}
                        </View>
                        {secondary ? (
                          <Text
                            numberOfLines={1}
                            style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.5) }}
                          >
                            {secondary}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </GlassCard>

          {/* 4. Billing history — real Stripe invoices + topups. Each row opens
              hosted_invoice_url in the in-app browser. */}
          <GlassCard strong className="mb-3 p-4">
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Receipt size={13} strokeWidth={1.8} color={fg(0.55)} />
              <MicroLabel text={t("subscription.billingHistory")} tracking={1.4} color={fg(0.55)} />
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => void onManage()} disabled={actionPending} hitSlop={8}>
                <Text
                  style={{
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 10,
                    lineHeight: 14,
                    color: fg(0.55),
                    opacity: actionPending ? 0.5 : 1,
                  }}
                >
                  {t("subscription.viewAllOnStripe")}
                </Text>
              </Pressable>
            </View>
            {paymentHistory.length === 0 ? (
              <Text style={{ paddingVertical: 4, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.55) }}>
                {t("subscription.noPaymentsYet")}
              </Text>
            ) : (
              <View>
                {paymentHistory.map((inv, index) => {
                  const dateStr = new Date(inv.createdAt * 1000).toLocaleDateString("en-US", {
                    year: "numeric", month: "short", day: "numeric",
                  });
                  const amount = `$${(inv.amountPaidCents / 100).toFixed(2)}`;
                  const invStatusLabel = inv.status === "paid" ? t("subscription.invoicePaid")
                    : inv.status === "open" ? t("subscription.invoiceOpen")
                    : inv.status === "draft" ? t("subscription.invoiceDraft")
                    : inv.status === "void" ? t("subscription.invoiceVoid")
                    : inv.status === "uncollectible" ? t("subscription.invoiceFailed")
                    : inv.status;
                  const row = (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        paddingVertical: 10,
                        borderTopWidth: index > 0 ? 1 : 0,
                        borderTopColor: fg(0.06),
                      }}
                    >
                      <Calendar size={13} strokeWidth={1.7} color={fg(0.4)} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          numberOfLines={1}
                          style={{ fontFamily: "Inter_500Medium", fontSize: 13, lineHeight: 19, color: fg(0.85) }}
                        >
                          {inv.description}
                        </Text>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                          {dateStr}
                        </Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={[{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: fg() }, MONO]}>
                          {amount}
                        </Text>
                        <View style={{ borderRadius: 18, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: fg(0.06) }}>
                          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                            {invStatusLabel}
                          </Text>
                        </View>
                      </View>
                    </View>
                  );
                  return inv.hostedInvoiceUrl ? (
                    <Pressable key={`${inv.kind}:${inv.id}`} onPress={() => openInvoice(inv.hostedInvoiceUrl!)}>
                      {row}
                    </Pressable>
                  ) : (
                    <View key={`${inv.kind}:${inv.id}`}>{row}</View>
                  );
                })}
              </View>
            )}
          </GlassCard>

          {/* 5. Cancel — wired to /api/payment/cancel (cancel_at_period_end).
              Two-tap inline confirm (avoids window.confirm hangs in some
              webview contexts). Disabled when Free or already scheduled. */}
          <View style={{ flexDirection: "row", alignItems: "stretch", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Pressable
                onPress={onCancel}
                disabled={actionPending || isFree || sub.cancelAtPeriodEnd}
              >
              <View
                style={{
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: red(0.25),
                  backgroundColor: red(0.04),
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  opacity: actionPending || isFree || sub.cancelAtPeriodEnd ? 0.5 : 1,
                }}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: red(0.1),
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <AlertTriangle size={16} strokeWidth={1.8} color={RED_ICON} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: RED_TEXT }}>
                    {sub.cancelAtPeriodEnd
                      ? t("subscription.cancellationScheduled")
                      : confirmingCancel
                        ? t("subscription.tapToConfirm")
                        : t("subscription.cancelSubscription")}
                  </Text>
                  <Text style={{ marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.5) }}>
                    {isFree
                      ? t("subscription.nothingToCancel")
                      : sub.cancelAtPeriodEnd && periodEnd
                        ? t("subscription.planEnds", { date: periodEnd })
                        : confirmingCancel
                          ? t("subscription.keepFeaturesUntil", { plan: planLabel, date: periodEnd ?? t("subscription.periodEnd") })
                          : t("subscription.cancelKeepUntil", { plan: planLabel, date: periodEnd ?? t("subscription.periodEnd") })}
                  </Text>
                </View>
              </View>
              </Pressable>
            </View>
            {confirmingCancel && !sub.cancelAtPeriodEnd ? (
              <Pressable onPress={() => setConfirmingCancel(false)} disabled={actionPending}>
                <View
                  style={{
                    flex: 1,
                    paddingHorizontal: 12,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: fg(0.15),
                    backgroundColor: fg(0.02),
                    justifyContent: "center",
                    opacity: actionPending ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.65) }}>
                    {t("subscription.keepIt")}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
