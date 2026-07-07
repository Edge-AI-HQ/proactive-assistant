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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Globe,
  Hand,
  Keyboard,
  Minimize2,
  RotateCw,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  runOnJS,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { BrowserControlMode, BrowserInput, BrowserSession } from "@pin-ai/core";
import { useBrowserSession } from "@pin-ai/state";

import { Spinner } from "../../ui/Spinner";

/** web bg-[hsl(230_22%_9%)] / bg-[hsl(230_18%_13%)] 同源暗色。 */
const PANEL_BG = "hsl(230, 22%, 9%)";
const BAR_BG = "hsl(230, 18%, 13%)";

const clampTo = (v: number, max: number) => Math.min(Math.max(v, 0), max);

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
  topInset = 0,
  onControlChange,
  sendInput,
  onCollapse,
  onRequestClose,
}: {
  session: BrowserSession;
  reloadKey: number;
  /** 满屏 sheet 场景的 home-indicator 底部安全区。 */
  bottomInset?: number;
  /** 顶部刘海安全区。全屏 Modal 逃出根 SafeAreaProvider，Modal 内 useSafeAreaInsets
   *  读数不可靠 → 由宿主（ChatSheet）显式传 insets.top，面板自己垫下来避刘海。 */
  topInset?: number;
  onControlChange: (mode: BrowserControlMode) => void;
  sendInput: (input: BrowserInput) => Promise<Record<string, unknown> | null>;
  onCollapse: () => void;
  onRequestClose: () => void;
}) {
  const { t } = useTranslation(["browser", "common"]);
  const [loaded, setLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  // kbVisible = 隐藏输入框已聚焦（iOS 键盘已弹）。用户接管后 Type 键盘钮常驻——远端是
  // 桌面 mouse 会话、click 不回传是否可编辑，故不再按字段可编辑性动态显隐。
  const [kbVisible, setKbVisible] = useState(false);
  const hiddenInputRef = useRef<TextInput>(null);
  const isAi = session.controlMode === "ai";

  // 前台回切 → reloadKey 自增 → WebView 换 key 重挂并重新加载 live view。
  // 重挂时 loaded 归零重新盖遮罩；但仅靠 onLoadEnd 清除有风险——签名 live-view URL
  // 刷新失败时 onLoadEnd 永不触发、遮罩会永久卡死（只能关重开）。故 onError/onHttpError
  // 也清（见 WebView），并加 8s 超时兜底：无论加载成功 / 失败 / 静默卡住，遮罩最多盖 8s。
  useEffect(() => {
    setLoaded(false);
    const t = setTimeout(() => setLoaded(true), 8000);
    return () => clearTimeout(t);
  }, [reloadKey]);

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

  // 顶部把手手势（对齐 dev BrowserDrawer 的 drag-down dismiss）：只把手起拖 → 不和
  // 下面的 WebView 抢手势。下拉跟手（往上 clamp 0）；松手过 120px 或快速下滑
  // （vy>600）即 collapse，否则 spring 回弹。轻点把手仍收起（Tap 与 Pan 竞速）。
  const dragY = useSharedValue(0);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.value }] }));
  const handleGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .onUpdate((e) => {
        dragY.value = Math.max(0, e.translationY);
      })
      .onEnd((e) => {
        if (e.translationY > 120 || e.velocityY > 600) {
          runOnJS(onCollapse)();
        } else {
          dragY.value = withSpring(0, { stiffness: 500, damping: 40, overshootClamping: true });
        }
      });
    const tap = Gesture.Tap().onEnd(() => runOnJS(onCollapse)());
    return Gesture.Race(pan, tap);
  }, [dragY, onCollapse]);

  // ── 页面交互（user 接管后）：移植 dev BrowserView 的 overlay+CDP 模型。vendor live
  //    view 在触屏上只读（desktop-mouse-only）→ WebView 恒 pointerEvents:none，本层手势
  //    把 轻点→CDP tap、拖动→CDP scroll 转发给远端；坐标按远端视口 / 框尺寸缩放。 ──
  // 远端画面按 object-fit: contain 缩放进本地框（保宽高比 + 居中留黑边）。坐标换算必须补
  //    偏移 + 等比缩放，否则黑边（上下或左右）会让 tap 偏位——小目标点不准 / 点到邻近元素
  //    （= 你报的搜索历史 X 点成跳转）。scale = 等比系数，offsetX/Y = 单侧黑边宽。运行时读
  //    session.viewport（真实远端尺寸，默认 desktop 1280×800）。
  const boxSizeRef = useRef({ w: 0, h: 0 });
  const remoteMap = useCallback(() => {
    const { w, h } = boxSizeRef.current;
    const vp = session.viewport;
    if (w < 1 || h < 1 || vp.width < 1 || vp.height < 1) return null;
    const scale = Math.min(w / vp.width, h / vp.height);
    return {
      scale,
      offsetX: (w - vp.width * scale) / 2,
      offsetY: (h - vp.height * scale) / 2,
      vpW: vp.width,
      vpH: vp.height,
    };
  }, [session.viewport]);

  // 页面输入串行队列（tap/text/key 保序）：远端按到达顺序 apply，async POST 并发会乱序
  //    （"退5格 + 打你好" 可能变成 "打你好 + 退5格" → 吞字）。链式 Promise 保证严格有序。
  const sendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueInput = useCallback(
    (input: BrowserInput): Promise<Record<string, unknown> | null> => {
      const p = sendQueueRef.current.then(() => sendInput(input)).catch(() => null);
      sendQueueRef.current = p.catch(() => undefined);
      return p;
    },
    [sendInput],
  );

  // 本地打字缓冲 = 上次「已发到远端的串」。远端字段是画面(screencast)、client 看不到其
  //    真实内容 → 每次 tap 都重置缓冲：focus 换字段 / 清内容 / 移光标后，旧缓冲失效。
  const lastTypedRef = useRef("");
  const resetTypingBuffer = useCallback(() => {
    hiddenInputRef.current?.clear();
    lastTypedRef.current = "";
  }, []);

  // 轻点 → CDP **click（mouse）**：远端是 desktop / hasTouch=false 会话（manager
  //    _DEFAULT_VIEWPORT desktop 1280×800、CDP 下 hasTouch 改不了），只认鼠标——合成
  //    touch 触不动原生 X 清除钮等 mouse-only 元素。改发 mouse click 命中所有桌面元素。
  //    click 改变 focus/内容 → 先重置打字缓冲。
  const handleTap = useCallback(
    (localX: number, localY: number) => {
      const m = remoteMap();
      if (!m) return;
      resetTypingBuffer();
      const x = Math.round(clampTo((localX - m.offsetX) / m.scale, m.vpW));
      const y = Math.round(clampTo((localY - m.offsetY) / m.scale, m.vpH));
      void enqueueInput({ type: "click", x, y });
    },
    [remoteMap, enqueueInput, resetTypingBuffer],
  );

  // 拖动 → CDP scroll（内容跟手：手指上滑=页面下滚，故取负）。累积 + ~30fps 节流合批，
  //    避免每帧一个 POST 打爆网络（dev 用 rAF flush，此处 setTimeout 合帧等价）。
  const scrollAccumRef = useRef({ dx: 0, dy: 0 });
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueScroll = useCallback(
    (rawDx: number, rawDy: number) => {
      const m = remoteMap();
      if (!m) return;
      // scroll 位移等比缩放（÷scale = ×远端每本地 px），无偏移（偏移只对绝对坐标点生效）。
      scrollAccumRef.current.dx += -rawDx / m.scale;
      scrollAccumRef.current.dy += -rawDy / m.scale;
      if (scrollTimerRef.current == null) {
        scrollTimerRef.current = setTimeout(() => {
          scrollTimerRef.current = null;
          const { dx, dy } = scrollAccumRef.current;
          scrollAccumRef.current = { dx: 0, dy: 0 };
          if (dx !== 0 || dy !== 0) {
            void sendInput({ type: "scroll", dx: Math.round(dx), dy: Math.round(dy) });
          }
        }, 32);
      }
    },
    [remoteMap, sendInput],
  );
  useEffect(
    () => () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    },
    [],
  );

  // Race：拖过阈值 → Pan（滚动）；轻点静止松手 → Tap（点按）。手势在 UI 线程 worklet，
  //    处理器走 runOnJS 回 JS（读 ref / 发网络）。本帧位移增量 = translation 差分（panLast
  //    用 sharedValue 存，worklet 里可读写；本版 RNGH payload 无 changeX/Y）。
  const panLast = useSharedValue({ x: 0, y: 0 });
  const pageGesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDistance(8)
      .maxDuration(500)
      .onEnd((e) => runOnJS(handleTap)(e.x, e.y));
    const pan = Gesture.Pan()
      .onBegin(() => {
        panLast.value = { x: 0, y: 0 };
      })
      .onUpdate((e) => {
        const dx = e.translationX - panLast.value.x;
        const dy = e.translationY - panLast.value.y;
        panLast.value = { x: e.translationX, y: e.translationY };
        runOnJS(queueScroll)(dx, dy);
      });
    return Gesture.Race(pan, tap);
  }, [handleTap, queueScroll, panLast]);

  // 逐字实时打字：本地隐藏 TextInput 作编辑缓冲，与「上次已发到远端的串」做**公共前缀
  //    diff**——删掉变化后缀（Backspace）+ 补打新后缀（text）。这天然正确处理中文 IME：
  //    待选区把拼音替换成汉字时只 diff 出「退拼音 + 打汉字」的最小编辑，不再整串重打
  //    （旧版吞字 / 整框刷新的根因）。所有 send 走串行队列保序。Enter 走 onSubmitEditing。
  const handleTypeText = useCallback(
    (next: string) => {
      const prev = lastTypedRef.current;
      if (next === prev) return;
      let p = 0;
      const min = Math.min(prev.length, next.length);
      while (p < min && prev[p] === next[p]) p += 1;
      lastTypedRef.current = next;
      for (let i = 0; i < prev.length - p; i += 1) void enqueueInput({ type: "key", key: "Backspace" });
      const additions = next.slice(p);
      if (additions) void enqueueInput({ type: "text", text: additions });
    },
    [enqueueInput],
  );

  return (
    // 全屏 Modal：逃出 ChatScreen 容器（那被夹在 ChatSheet header + 刘海之下），
    // 让面板真正盖住整屏。Modal 内手势须自带 GestureHandlerRootView。
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={onCollapse}>
    <GestureHandlerRootView style={styles.modalRoot}>
    {/* 上滑入场 / 退场（对齐 dev BrowserDrawer 的 slide-up）。panelSlide 持暗底铺满
        整屏（含刘海后面）；内层 panel 承接下拉手势位移，用 topInset 垫开刘海。 */}
    <Animated.View
      entering={SlideInDown.duration(300)}
      exiting={SlideOutDown.duration(250)}
      style={styles.panelSlide}
    >
    <Animated.View style={[styles.panel, dragStyle, { paddingTop: topInset, paddingBottom: bottomInset }]}>
      {/* 顶部把手（dev drawer grab handle）：下拉退出（Pan）/ 轻点收起（Tap）。 */}
      <GestureDetector gesture={handleGesture}>
        <View style={styles.handleRow}>
          <View style={styles.handle} />
        </View>
      </GestureDetector>

      {/* Top control bar — control toggle on the left; collapse / end-session
          on the right（dev BrowserView 同构，无 status pill）。 */}
      <View style={styles.controlBar}>
        <View style={styles.controlBarLeft}>
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
          {/* Type：用户接管后常驻 → 唤起 / 收起 iOS 键盘（先 click 一个远端输入框聚焦它，
              再点 Type 打字）。放控制条（手势 overlay 之外，点击 100% 可靠）；dev 是 live
              view 内底部 contextual pill——RN 改顶栏是刻意的平台适配，避免和手势层抢触摸。 */}
          {!isAi ? (
            <Pressable
              onPress={() =>
                kbVisible ? hiddenInputRef.current?.blur() : hiddenInputRef.current?.focus()
              }
              accessibilityRole="button"
              accessibilityLabel={t("browser:view.summonKeyboard")}
            >
              <View style={[styles.ctrlBtn, styles.ctrlBtnType]}>
                {kbVisible ? (
                  <ChevronDown size={12} strokeWidth={2} color="rgba(255,255,255,0.85)" />
                ) : (
                  <Keyboard size={12} strokeWidth={2} color="rgba(255,255,255,0.85)" />
                )}
                <Text style={styles.ctrlBtnText}>
                  {kbVisible ? t("common:status.done") : t("browser:view.summonKeyboard")}
                </Text>
              </View>
            </Pressable>
          ) : null}
        </View>
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

      {/* Live-view box（dev iframe → RN WebView）。触屏上 vendor live view 只读
          (desktop-mouse-only) → WebView 恒 pointerEvents:none 只读，页面交互全走上面的
          手势层转 CDP（dev BrowserView 同构）。onLayout 量框尺寸供坐标缩放。 */}
      <View
        style={styles.viewBox}
        onLayout={(e) => {
          boxSizeRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
        }}
      >
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
          // 加载失败也揭遮罩（否则 onLoadEnd 不来 → 永久黑遮罩）：onError=网络失败、
          // onHttpError=HTTP 状态失败（如签名 URL 过期返 403）。配合上面 8s 超时双保险。
          onError={() => setLoaded(true)}
          onHttpError={() => setLoaded(true)}
          style={styles.webview}
          // 恒只读：AI 驾驶时指针属于隐式 takeover 层，user 接管后属于下面的手势转发层。
          pointerEvents="none"
          allowsInlineMediaPlayback
        />

        {isAi ? (
          /* AI 驾驶：透明层捕获首次点按 → 隐式 takeover（与显式 Take over 同态）。 */
          <Pressable
            onPress={() => onControlChange("user")}
            accessibilityRole="button"
            accessibilityLabel={t("browser:view.takeControl")}
            style={StyleSheet.absoluteFill}
          >
            <View style={StyleSheet.absoluteFill} />
          </Pressable>
        ) : (
          /* User 接管：全屏手势层（轻点→CDP tap / 拖动→CDP scroll）+ 隐藏输入框（键盘 sink，
             逐字 diff 转 CDP text/key）。 */
          <>
            <GestureDetector gesture={pageGesture}>
              <View style={StyleSheet.absoluteFill} collapsable={false} />
            </GestureDetector>
            <TextInput
              ref={hiddenInputRef}
              onChangeText={handleTypeText}
              onKeyPress={(e) => {
                // 缓冲已空时的 Backspace = 删「进入本次编辑前远端已有」的旧内容：onChangeText
                //    删不动空串 → 直接转发一个 Backspace（远端在光标处删一个字符）。
                if (e.nativeEvent.key === "Backspace" && lastTypedRef.current.length === 0) {
                  void enqueueInput({ type: "key", key: "Backspace" });
                }
              }}
              onFocus={() => setKbVisible(true)}
              onBlur={() => {
                setKbVisible(false);
                resetTypingBuffer();
              }}
              onSubmitEditing={() => void enqueueInput({ type: "key", key: "Enter" })}
              blurOnSubmit={false}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardAppearance="dark"
              style={styles.hiddenInput}
            />
          </>
        )}
      </View>
    </Animated.View>
    </Animated.View>
    </GestureHandlerRootView>
    </Modal>
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
  // GestureHandlerRootView 须铺满，Modal 内的把手手势才生效。
  modalRoot: { flex: 1 },
  // 入/退场滑动层：持暗底铺满整屏（含刘海后面），dev BrowserDrawer 的暗底同源。
  panelSlide: { flex: 1, backgroundColor: PANEL_BG },
  // 内容层：承接下拉手势的 translateY 位移（topInset 由 inline 垫刘海）。
  panel: { flex: 1 },
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
  controlBarLeft: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 },
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
  ctrlBtnType: { backgroundColor: "rgba(255,255,255,0.08)" },
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
  // 隐藏输入框：仅作键盘 / 输入 sink，画面外（left -9999），逐字 diff → CDP text/key。
  hiddenInput: { position: "absolute", left: -9999, top: 0, width: 1, height: 1, opacity: 0 },
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
