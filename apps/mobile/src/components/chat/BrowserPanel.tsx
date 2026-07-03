/**
 * Browser live view（agent browser_tool 的远端浏览器）——web 三件套的 RN 介质版：
 * - useBrowserPanel：ui-web/chat/conversation/useBrowserPanel 的 RN 对应（同一个
 *   @pin-ai/state useBrowserSession，thread 级 SSE + 心跳 + 控制命令；前台回切时
 *   refreshLiveView + 换 key 重挂 WebView——iOS 后台会掐 Browserbase WebSocket，
 *   dev 用 visibilitychange/appStateChange，RN 用 AppState）。
 * - BrowserHeaderBar：ui-web/browser/BrowserHeader——session 存在但面板收起时贴在
 *   composer 上沿的入口条；ambient（AI 在后台浏览）与 attention（request_takeover，
 *   琥珀高亮）两态。文案 dev 为硬编码英文，此处照抄。
 * - BrowserPanel：ui-web/browser/BrowserDrawer + BrowserView 合体——手机窄屏永远
 *   是全屏 bottom-sheet（dev canSplitBrowser 只在 ≥1024px 桌面开）。控制条
 *   （Take over / Return to AI + collapse + end-session 二次确认）+ 地址栏
 *   （back/forward/reload + URL 输入）+ WebView живой live view。
 *
 * 介质差异：dev iframe 在 touch 端只读、自建手势 overlay 把 tap/scroll 转发成
 * CDP 输入；RN WebView 是真 WKWebView，用户接管后触摸直接落在 live view 页面里
 * （无需自建转发层）。AI 驾驶时与 dev 同构：透明层捕获首次点按 → 隐式 takeover。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Globe,
  Hand,
  Minimize2,
  RotateCw,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import type { BrowserControlMode, BrowserInput, BrowserSession } from "@pin-ai/core";
import { useBrowserSession } from "@pin-ai/state";

import { Spinner } from "../../ui/Spinner";

/** web bg-[hsl(230_22%_9%)] / bg-[hsl(230_18%_13%)] 同源暗色。 */
const PANEL_BG = "hsl(230, 22%, 9%)";
const BAR_BG = "hsl(230, 18%, 13%)";

export interface BrowserPanelState {
  session: BrowserSession | null;
  panelOpen: boolean;
  /** AI 呼救（request_takeover）——面板收起时入口条转琥珀 attention 态。 */
  attention: boolean;
  /** 前台回切自增，用作 WebView remount key（dev iframeReloadKey）。 */
  reloadKey: number;
  /** 入口条点开面板；attention 态下等于用户接手 → 顺手切 user 控制。 */
  openFromHeader: () => void;
  closePanel: () => void;
  setControl: (mode: BrowserControlMode) => void;
  sendInput: (input: BrowserInput) => Promise<Record<string, unknown> | null>;
  close: () => void;
}

/** ui-web useBrowserPanel 的 RN 对应物（layout 分支除外——手机永远 drawer）。 */
export function useBrowserPanel(threadId: string | null): BrowserPanelState {
  const {
    session,
    panelOpen,
    openPanel,
    closePanel,
    setControl,
    sendInput,
    refreshLiveView,
    close,
  } = useBrowserSession(threadId ?? "");

  // On foreground return, iOS may pause the Live View WebSocket + expire its
  // signed URL. Refresh the URL then bump the WebView key（不动转录/composer）。
  const [reloadKey, setReloadKey] = useState(0);
  const lastReloadAtRef = useRef(0);
  useEffect(() => {
    const bump = () => {
      const now = Date.now();
      if (now - lastReloadAtRef.current < 1500) return;
      lastReloadAtRef.current = now;
      void (async () => {
        await refreshLiveView();
        setReloadKey((k) => k + 1);
      })();
    };
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") bump();
    });
    return () => sub.remove();
  }, [refreshLiveView]);

  // Header click opens the panel. If the AI asked for help (attention state),
  // the user opening it means they're stepping in → take control for them.
  const attention = !!session?.takeoverReason;
  const controlMode = session?.controlMode;
  const openFromHeader = useCallback(() => {
    openPanel();
    if (attention && controlMode !== "user") {
      void setControl("user");
    }
  }, [openPanel, attention, controlMode, setControl]);

  const handleSetControl = useCallback(
    (mode: BrowserControlMode) => void setControl(mode),
    [setControl],
  );
  const handleClose = useCallback(() => void close(), [close]);

  return {
    session,
    panelOpen,
    attention,
    reloadKey,
    openFromHeader,
    closePanel,
    setControl: handleSetControl,
    sendInput,
    close: handleClose,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Composer 上沿入口条（web BrowserHeader）：session 存在、面板收起时显示。
 * ambient 低调态 / attention 琥珀态两种。文案照 dev 硬编码。
 */
export function BrowserHeaderBar({
  currentUrl,
  attention,
  attentionReason,
  onOpen,
}: {
  currentUrl: string;
  attention: boolean;
  attentionReason?: string | null;
  onOpen: () => void;
}) {
  const host = hostOf(currentUrl);

  if (attention) {
    return (
      <Pressable onPress={onOpen} accessibilityRole="button">
        <View style={[styles.headerBar, styles.headerBarAttention]}>
          <CircleAlert size={15} color="#f59e0b" />
          <View style={styles.headerCopy}>
            <Text style={styles.headerAttentionTitle}>Browser needs you</Text>
            {attentionReason ? (
              <Text style={styles.headerAttentionReason} numberOfLines={1}>
                {attentionReason}
              </Text>
            ) : null}
          </View>
          <View style={styles.headerOpenPill}>
            <Text style={styles.headerOpenPillText}>Open</Text>
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onPress={onOpen} accessibilityRole="button">
      <View style={styles.headerBar}>
        <View style={styles.headerGlobe}>
          <Globe size={15} color={`rgba(${FG},0.55)`} />
          <View style={styles.headerLiveDot} />
        </View>
        <Text style={styles.headerAmbientText} numberOfLines={1}>
          {host ? (
            <>
              Browsing <Text style={styles.headerHost}>{host}</Text>
            </>
          ) : (
            "Browser ready"
          )}
        </Text>
        <ChevronUp size={15} color={`rgba(${FG},0.4)`} />
      </View>
    </Pressable>
  );
}

/**
 * 全屏 live-view 面板（web BrowserDrawer 壳 + BrowserView 内容）：
 * 控制条 + 地址栏 + WebView。挂在 ChatScreen 根上 absolute 铺满。
 */
export function BrowserPanel({
  session,
  reloadKey,
  bottomInset = 0,
  onControlChange,
  sendInput,
  onCollapse,
  onRequestClose,
}: {
  session: BrowserSession;
  reloadKey: number;
  /** 满屏 sheet 场景的 home-indicator 底部安全区。 */
  bottomInset?: number;
  onControlChange: (mode: BrowserControlMode) => void;
  sendInput: (input: BrowserInput) => Promise<Record<string, unknown> | null>;
  onCollapse: () => void;
  onRequestClose: () => void;
}) {
  const { t } = useTranslation(["browser", "common"]);
  const [loaded, setLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const isAi = session.controlMode === "ai";

  // 前台回切 → reloadKey 自增 → WebView 换 key 重挂并重新加载 live view。
  // 重挂时 loaded 需归零，否则加载遮罩不再出现（重载期间画面空着直到 onLoadEnd）。
  useEffect(() => setLoaded(false), [reloadKey]);

  // ── Address bar: a draft synced to the live URL, editable to navigate. ──
  const [urlDraft, setUrlDraft] = useState(session.currentUrl);
  useEffect(() => setUrlDraft(session.currentUrl), [session.currentUrl]);
  const submitUrl = () => {
    const raw = urlDraft.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    void sendInput({ type: "navigate", url });
  };

  // navbar=false strips the live-view player's faux address bar so our own
  // control bar is the only chrome（dev iframeSrc 同款）。
  const viewSrc = session.liveViewUrl.includes("?")
    ? `${session.liveViewUrl}&navbar=false`
    : `${session.liveViewUrl}?navbar=false`;

  return (
    <Animated.View
      entering={SlideInDown.duration(300)}
      exiting={SlideOutDown.duration(250)}
      style={[styles.panel, { paddingBottom: bottomInset }]}
    >
      {/* 顶部把手（dev drawer grab handle）：点按收起。 */}
      <Pressable onPress={onCollapse} accessibilityRole="button" accessibilityLabel={t("browser:view.collapse")}>
        <View style={styles.handleRow}>
          <View style={styles.handle} />
        </View>
      </Pressable>

      {/* Top control bar — control toggle on the left; collapse / end-session
          on the right（dev BrowserView 同构，无 status pill）。 */}
      <View style={styles.controlBar}>
        {isAi ? (
          <Pressable onPress={() => onControlChange("user")} accessibilityRole="button">
            <View style={[styles.ctrlBtn, styles.ctrlBtnTakeOver]}>
              <Hand size={12} strokeWidth={2} color="rgba(255,255,255,0.85)" />
              <Text style={styles.ctrlBtnText}>{t("browser:view.takeOver")}</Text>
            </View>
          </Pressable>
        ) : (
          <Pressable onPress={() => onControlChange("ai")} accessibilityRole="button">
            <View style={[styles.ctrlBtn, styles.ctrlBtnReturnAi]}>
              <Bot size={12} strokeWidth={2} color="#dbeafe" />
              <Text style={[styles.ctrlBtnText, styles.ctrlBtnTextBlue]}>
                {t("browser:view.returnToAi")}
              </Text>
            </View>
          </Pressable>
        )}
        <View style={styles.controlBarRight}>
          {confirmingClose ? (
            <>
              <Pressable onPress={() => setConfirmingClose(false)} accessibilityRole="button">
                <View style={styles.iconBtn}>
                  <Text style={styles.cancelText}>{t("common:status.cancel")}</Text>
                </View>
              </Pressable>
              <Pressable
                onPress={() => {
                  setConfirmingClose(false);
                  onRequestClose();
                }}
                accessibilityRole="button"
              >
                <View style={styles.endSessionBtn}>
                  <Text style={styles.endSessionText}>{t("browser:view.endSession")}</Text>
                </View>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={onCollapse}
                accessibilityRole="button"
                accessibilityLabel={t("browser:view.collapse")}
              >
                <View style={styles.iconBtn}>
                  <Minimize2 size={15} strokeWidth={2} color="rgba(255,255,255,0.65)" />
                </View>
              </Pressable>
              <Pressable
                onPress={() => setConfirmingClose(true)}
                accessibilityRole="button"
                accessibilityLabel={t("browser:view.endBrowserSession")}
              >
                <View style={styles.iconBtn}>
                  <X size={15} strokeWidth={2} color="rgba(255,255,255,0.65)" />
                </View>
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Address bar — back / forward / reload + editable URL. */}
      <View style={styles.addressBar}>
        <Pressable
          onPress={() => void sendInput({ type: "back" })}
          accessibilityRole="button"
          accessibilityLabel={t("browser:view.back")}
        >
          <View style={styles.iconBtn}>
            <ChevronLeft size={16} strokeWidth={2} color="rgba(255,255,255,0.65)" />
          </View>
        </Pressable>
        <Pressable
          onPress={() => void sendInput({ type: "forward" })}
          accessibilityRole="button"
          accessibilityLabel={t("browser:view.forward")}
        >
          <View style={styles.iconBtn}>
            <ChevronRight size={16} strokeWidth={2} color="rgba(255,255,255,0.65)" />
          </View>
        </Pressable>
        <Pressable
          onPress={() => void sendInput({ type: "reload" })}
          accessibilityRole="button"
          accessibilityLabel={t("browser:view.reload")}
        >
          <View style={styles.iconBtn}>
            <RotateCw size={14} strokeWidth={2} color="rgba(255,255,255,0.65)" />
          </View>
        </Pressable>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          onSubmitEditing={submitUrl}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          enterKeyHint="go"
          placeholder={t("browser:view.enterUrl")}
          placeholderTextColor="rgba(255,255,255,0.35)"
          accessibilityLabel={t("browser:view.addressBar")}
          style={styles.urlInput}
        />
      </View>

      {/* Live-view box（dev iframe → RN WebView）。 */}
      <View style={styles.viewBox}>
        {!loaded ? (
          <View style={styles.loadingOverlay}>
            <Spinner size={14} color="rgba(255,255,255,0.5)" />
            <Text style={styles.loadingText}>{t("browser:view.loading")}</Text>
          </View>
        ) : null}
        <WebView
          key={`live-${reloadKey}`}
          source={{ uri: viewSrc }}
          onLoadEnd={() => setLoaded(true)}
          style={styles.webview}
          // AI 驾驶时指针属于下面的隐式 takeover 层（dev iframe pointerEvents:none 同构）。
          pointerEvents={isAi ? "none" : "auto"}
          allowsInlineMediaPlayback
        />

        {/* Implicit takeover: in AI mode a transparent layer catches the first
            interaction and hands control to the user（与显式 Take over 同态）。 */}
        {isAi ? (
          <Pressable
            onPress={() => onControlChange("user")}
            accessibilityRole="button"
            accessibilityLabel={t("browser:view.takeControl")}
            style={StyleSheet.absoluteFill}
          >
            <View style={StyleSheet.absoluteFill} />
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const FG = "29,33,48";

const styles = StyleSheet.create({
  // ── header bar（composer 上沿入口条）──
  // web ambient: rounded-2xl border-foreground/[0.08] bg-foreground/[0.04] px-3.5 py-2。
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    backgroundColor: `rgba(${FG},0.04)`,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  // web attention: border-amber-400/40 bg-amber-400/15 py-2.5。
  headerBarAttention: {
    borderColor: "rgba(251,191,36,0.4)",
    backgroundColor: "rgba(251,191,36,0.15)",
    paddingVertical: 10,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerAttentionTitle: {
    fontSize: 13,
    lineHeight: 18,
    color: "#1d2130",
    fontFamily: "Geist_500Medium",
  },
  headerAttentionReason: {
    fontSize: 11,
    lineHeight: 15,
    color: `rgba(${FG},0.55)`,
    fontFamily: "Geist_400Regular",
  },
  // web: rounded-full bg-amber-500 px-2 py-0.5 text-caption font-semibold text-white。
  headerOpenPill: {
    borderRadius: 999,
    backgroundColor: "#f59e0b",
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  headerOpenPillText: { fontSize: 11, lineHeight: 15, color: "#fff", fontFamily: "Geist_600SemiBold" },
  headerGlobe: { width: 18, alignItems: "center", justifyContent: "center" },
  // web: absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse。
  headerLiveDot: {
    position: "absolute",
    right: -1,
    top: -1,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#0ea5e9",
  },
  headerAmbientText: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    color: `rgba(${FG},0.7)`,
    fontFamily: "Geist_400Regular",
  },
  headerHost: { color: `rgba(${FG},0.9)` },

  // ── panel ──
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 40,
    backgroundColor: PANEL_BG,
  },
  handleRow: { alignItems: "center", paddingVertical: 8 },
  handle: { height: 6, width: 48, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.4)" },
  controlBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    backgroundColor: BAR_BG,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  controlBarRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  // web ctrlBtn: px-2.5 py-1 rounded-full text-caption。
  ctrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  ctrlBtnTakeOver: { backgroundColor: "rgba(255,255,255,0.08)" },
  ctrlBtnReturnAi: { backgroundColor: "rgba(59,130,246,0.25)" },
  ctrlBtnText: { fontSize: 11, lineHeight: 15, color: "rgba(255,255,255,0.85)", fontFamily: "Geist_500Medium" },
  ctrlBtnTextBlue: { color: "#dbeafe" },
  iconBtn: { padding: 6, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  cancelText: { fontSize: 11, lineHeight: 15, color: "rgba(255,255,255,0.75)", fontFamily: "Geist_400Regular" },
  endSessionBtn: {
    borderRadius: 6,
    backgroundColor: "rgba(239,68,68,0.85)",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  endSessionText: { fontSize: 11, lineHeight: 15, color: "#fff", fontFamily: "Geist_500Medium" },
  addressBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    backgroundColor: BAR_BG,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  // web: rounded-full bg-white/[0.08] px-3 py-1 text-caption text-white/85。
  urlInput: {
    flex: 1,
    minWidth: 0,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    fontSize: 11,
    color: "rgba(255,255,255,0.85)",
  },
  viewBox: { flex: 1, backgroundColor: "#000" },
  webview: { flex: 1, backgroundColor: "#000" },
  loadingOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.8)",
  },
  loadingText: { fontSize: 13, color: "rgba(255,255,255,0.5)", fontFamily: "Geist_400Regular" },
});
