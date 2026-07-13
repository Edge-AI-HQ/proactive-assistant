/**
 * PIN 硬件(MR20 录音器)入口卡 + 全屏管理页——web(已退役 Capacitor 前端)
 * PinHardwareDeviceManager/PinHardwareManagementPage 的 RN 介质版,交互模型
 * 一致:
 * - 顶部 手机/PIN 设备 tab 固定,只切换看哪路流,不碰录制状态(纯查看器模型)
 * - 手机 tab = Ambient 手机收录的只读投影:当天历史(Live 同一条数据管线)
 *   新在上 + Listening 占位行置顶;关着则提示去 Ambient 来源开启
 * - PIN tab = 扫描/连接/设备管理;连接即录(显式连接成功自动开始转录),
 *   采集横幅+转录内嵌,结束=断开;连接过程三步 stepper
 * - 互斥:开始硬件转录时同一 consent patch 关手机源
 * - 逐行标记;关键节点触感反馈
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowLeft,
  BatteryMedium,
  Bluetooth,
  Bookmark,
  Check,
  ChevronRight,
  Mic,
  Play,
  Radio,
  RefreshCw,
  Smartphone,
  Unplug,
} from "lucide-react-native";
import type { EventSubscription } from "expo-modules-core";
import { mintPinHardwareAsrToken, PinHardwareAsrNotConfiguredError } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import {
  PinHardware,
  type PinHardwareState,
  type PinHardwareTranscriptEvent,
} from "../../../modules/pin-hardware";
import { useAmbientLiveSession } from "../../hooks/useAmbientLiveSession";
import {
  getAmbientEnabledSnapshot,
  resumeAmbientIfEnabled,
  setAmbientEnabledFlag,
  subscribeAmbientEnabled,
} from "../../ambient/runtime";
import type { LiveSessionData } from "../../ambient/live/live-session";
import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";
import { StaticVideoBackdrop } from "../../ui/VideoBackdrop";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;
/** 品红主题色 hsl(304 75% 63%) ≈ rgb(231,90,222);深字 48% ≈ rgb(199,31,187)。 */
const PINK = "231,90,222";
const pink = (a: number) => `rgba(${PINK},${a})`;
const PINK_SOLID = "rgb(199,31,187)";
const PINK_TEXT = "rgb(158,25,148)";

const PHONE_TRANSCRIPT_MAX = 120;

export interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
  capturedAt: string;
  provider?: string;
  marked?: boolean;
  pending?: boolean;
  placeholder?: boolean;
}

type ActiveSource = "phone" | "pin";
type BusyAction = "scan" | "connect" | "capture" | "disconnect" | null;
type StatusTone = "ok" | "active" | "warn" | "muted";

// ── 纯函数(与 web 版同语义) ─────────────────────────────────────────────

/** 转录合并:时序向下,interim 原位更新(保留标记),final 追加尾部。 */
export function mergeTranscriptEvent(
  prev: TranscriptLine[],
  event: PinHardwareTranscriptEvent,
): TranscriptLine[] {
  const capturedAt = event.capturedAt;
  const diarized = (event.segments ?? []).filter(
    (segment) => segment.text.trim().length > 0 && (segment.speakerLabel || segment.speakerId),
  );
  if (diarized.length > 0) {
    const lines: TranscriptLine[] = diarized
      .filter((segment) => segment.isFinal !== false)
      .map((segment, index) => ({
        id: `pin:seg:${capturedAt}:${index}:${segment.text}`,
        speaker: segment.speakerLabel?.trim()
          || (segment.speakerId?.trim() ? `Speaker ${segment.speakerId.trim()}` : "PINAI"),
        text: segment.text.trim(),
        capturedAt,
        provider: event.provider,
      }));
    if (lines.length === 0) return prev;
    return [...prev, ...lines].slice(-40);
  }
  const text = event.text.trim();
  if (!text) return prev;
  // voiceId 是腾讯每个 ASR 会话的唯一标识:自愈 restartAsr 后新会话的
  // sliceIndex 从 0 重新计数,不掺代际会与旧行 id 碰撞、原位覆盖历史。
  const key = event.sliceIndex != null
    ? `pin:${event.deviceId ?? "unknown"}:${event.voiceId ?? "s0"}:${event.sliceIndex}`
    : `pin:${capturedAt}:${text}`;
  const line: TranscriptLine = {
    id: key,
    speaker: event.deviceName?.trim() || "PINAI",
    text,
    capturedAt,
    provider: event.provider,
    pending: !event.isFinal,
  };
  const existingIndex = prev.findIndex((existing) => existing.id === key);
  if (existingIndex >= 0) {
    const next = prev.slice();
    next[existingIndex] = { ...line, marked: prev[existingIndex].marked };
    return next;
  }
  return [...prev, line].slice(-40);
}

export function summarizeState(
  t: TFunction<"connect">,
  state: PinHardwareState | null,
  enabled: boolean,
): { label: string; description: string; tone: StatusTone } {
  if (!enabled && state?.connected !== true && state?.captureRunning !== true) {
    return { label: t("pinHardware.status.notConfigured"), description: t("pinHardware.description.notConfigured"), tone: "muted" };
  }
  if (!state) {
    return { label: t("pinHardware.status.loading"), description: t("pinHardware.description.loading"), tone: "muted" };
  }
  if (!state.supported) {
    return { label: t("pinHardware.status.unsupported"), description: t("pinHardware.description.unsupported"), tone: "warn" };
  }
  if (state.status === "asr_error") {
    // ASR 断流自愈进行中(ambient source 里 re-mint+restartAsr)——按重连中呈现。
    return { label: t("pinHardware.status.asrError"), description: t("pinHardware.description.asrError"), tone: "active" };
  }
  if (state.captureRunning) {
    return {
      label: t("pinHardware.status.capturing"),
      description: t("pinHardware.description.capturing", { name: state.deviceName ?? t("pinHardware.deviceNameFallback") }),
      tone: "active",
    };
  }
  if (state.status === "capture_starting") {
    return { label: t("pinHardware.status.captureStarting"), description: t("pinHardware.description.captureStarting"), tone: "active" };
  }
  if (state.connected) {
    return {
      label: t("pinHardware.status.connected"),
      description: t("pinHardware.description.connected", { name: state.deviceName ?? t("pinHardware.deviceNameFallback") }),
      tone: "ok",
    };
  }
  if (state.status === "connecting" || state.status === "discovering_services") {
    return {
      label: t("pinHardware.status.connecting"),
      description: t("pinHardware.description.connecting", { name: state.deviceName ?? t("pinHardware.deviceNameFallback") }),
      tone: "active",
    };
  }
  if (state.status === "connect_retrying") {
    return { label: t("pinHardware.status.connectRetrying"), description: t("pinHardware.description.connectRetrying"), tone: "active" };
  }
  if (state.status === "connect_failed" || state.status === "service_discovery_failed" || state.status === "characteristic_discovery_failed") {
    return { label: t("pinHardware.status.connectFailed"), description: t("pinHardware.description.connectFailed"), tone: "warn" };
  }
  if (state.status === "service_not_found") {
    return { label: t("pinHardware.status.serviceNotFound"), description: t("pinHardware.description.serviceNotFound"), tone: "warn" };
  }
  if (state.scanning) {
    return { label: t("pinHardware.status.scanning"), description: t("pinHardware.description.scanning"), tone: "active" };
  }
  if (state.bluetoothState && state.bluetoothState !== "poweredOn") {
    return {
      label: t(`pinHardware.bluetooth.${state.bluetoothState}`, { defaultValue: state.bluetoothState }),
      description: t("pinHardware.description.bluetooth"),
      tone: "warn",
    };
  }
  return { label: t("pinHardware.status.ready"), description: t("pinHardware.description.ready"), tone: "muted" };
}

/** Live 同一条管线的数据 → 手机 tab 行(新在上);Listening 占位由视图渲染。 */
function phoneLinesFromLiveData(
  data: LiveSessionData | null,
  markedIds: ReadonlySet<string>,
): TranscriptLine[] {
  if (!data) return [];
  const lines: TranscriptLine[] = [];
  for (const message of data.messages) {
    const text = message.text?.trim();
    if (!text || message.id === "listening" || text === "Listening...") continue;
    const id = `phone:${message.id}`;
    lines.push({
      id,
      speaker: message.source?.trim() || "我",
      text,
      capturedAt: new Date(message.sortTs ?? data.startedAt).toISOString(),
      provider: "phone_mic",
      marked: markedIds.has(id),
    });
  }
  return lines.slice(-PHONE_TRANSCRIPT_MAX).reverse();
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function speakerInitial(label: string): string {
  const normalized = label.trim();
  const speakerMatch = /^Speaker\s+(.+)$/i.exec(normalized);
  if (speakerMatch?.[1]) return `S${speakerMatch[1]}`;
  if (normalized.toUpperCase() === "PINAI") return "PIN";
  return normalized.slice(0, 2).toUpperCase() || "S";
}

// ── 容器 ────────────────────────────────────────────────────────────────

export default function PinHardwareDeviceManager({
  userId,
  onOpenAmbientSettings,
}: {
  /** 开始采集时开本机主闸并驱动 ambient runtime 用。 */
  userId: string;
  /** 跳到 Ambient 页(录音状态控制点);管理页浮层先自行关闭。可选。 */
  onOpenAmbientSettings?: () => void;
}) {
  const { t } = useTranslation("connect");
  const { settings, patch } = useUserSettings();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<PinHardwareState | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [markedPhoneIds, setMarkedPhoneIds] = useState<ReadonlySet<string>>(new Set());
  const [source, setSource] = useState<ActiveSource>("pin");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const captureRunningRef = useRef(false);
  const connectedRef = useRef(false);
  const activeDeviceIdRef = useRef<string | null>(null);
  // 显式点连接才置位:连上即自动开始转录;后台自动重连(默认设备)不置位——
  // 无用户动作不静默开录。
  const autoStartOnConnectRef = useRef(false);
  const startCaptureRef = useRef<(() => Promise<void>) | null>(null);

  const pinConsentEnabled = settings?.ambientSources?.pin_hardware?.enabled === true;
  const phoneConsentEnabled = settings?.ambientSources?.sound_classifier?.enabled === true;
  // 本机主闸(per-device opt-in):consent 只是授权记录,主闸关着没有任何源在录。
  // 只看 consent 会在隐私敏感面上显示假的「正在录制」指示。
  const deviceGateOpen = useSyncExternalStore(subscribeAmbientEnabled, getAmbientEnabledSnapshot) === true;
  const phoneReady = deviceGateOpen && phoneConsentEnabled;

  // 手机流 = Live 卡同一条管线(当天回放 + 内存实时流)。active 门:只在
  // 管理页开着且看手机 tab 时才 5s 轮询(WS8 省电,组件挂在 KeepAlive 页里)。
  const { data: ambientLiveData } = useAmbientLiveSession({
    ambientOn: phoneReady,
    active: expanded && source === "phone",
  });
  const phoneTranscripts = useMemo(
    () => phoneLinesFromLiveData(ambientLiveData, markedPhoneIds),
    [ambientLiveData, markedPhoneIds],
  );

  const refreshState = useCallback(async () => {
    try {
      setState(await PinHardware.getState());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let stateSub: EventSubscription | null = null;
    let transcriptSub: EventSubscription | null = null;
    void (async () => {
      try {
        stateSub = PinHardware.addListener("pinHardwareState", (event: PinHardwareState) => {
          const wasConnected = connectedRef.current;
          const isConnected = event.connected === true;
          connectedRef.current = isConnected;
          const isCapturing = isConnected && event.captureRunning === true;
          const captureJustStarted = !captureRunningRef.current && isCapturing;
          if (captureJustStarted) {
            activeDeviceIdRef.current = event.deviceId ?? null;
            if (mounted) setTranscripts([]);
          } else if (!isCapturing) {
            activeDeviceIdRef.current = null;
          }
          captureRunningRef.current = isCapturing;

          // 旅程节点触感 + 显式连接直通转录(不用第二次点击)。
          if (!wasConnected && isConnected) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            if (autoStartOnConnectRef.current) {
              autoStartOnConnectRef.current = false;
              void startCaptureRef.current?.();
            }
          }
          if (captureJustStarted) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          }
          if (autoStartOnConnectRef.current
            && (event.status === "connect_failed" || event.status === "service_not_found")) {
            autoStartOnConnectRef.current = false;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          }

          if (mounted) setState(event);
        });
        transcriptSub = PinHardware.addListener(
          "pinHardwareTranscript",
          (event: PinHardwareTranscriptEvent) => {
            if (!captureRunningRef.current) return;
            const activeDeviceId = activeDeviceIdRef.current;
            if (activeDeviceId && event.deviceId && event.deviceId !== activeDeviceId) return;
            if (mounted) setTranscripts((prev) => mergeTranscriptEvent(prev, event));
          },
        );
        const current = await PinHardware.getState();
        connectedRef.current = current.connected === true;
        captureRunningRef.current = current.connected === true && current.captureRunning === true;
        activeDeviceIdRef.current = captureRunningRef.current ? current.deviceId ?? null : null;
        if (mounted) setState(current);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
      stateSub?.remove();
      transcriptSub?.remove();
    };
  }, []);

  const syncSourceConsent = useCallback(
    async (changes: Partial<Record<"pin_hardware" | "sound_classifier", boolean>>) => {
      const entries = Object.entries(changes) as Array<["pin_hardware" | "sound_classifier", boolean]>;
      if (entries.length === 0) return;
      await patch({
        ambientSources: Object.fromEntries(entries.map(([key, enabled]) => [key, { enabled }])),
      });
    },
    [patch],
  );

  // 老 web 版 syncSourceConsent 的后半段:开本机主闸 + 立即按 server consent
  // 调和 runtime。没有这步,主闸关着的用户开始采集时 pin_hardware ambient
  // source(信号入库 + ASR 自愈的唯一 owner)永远不会启动——音频推去腾讯、
  // 页面有字幕,但整场会话零入库、断流无人自愈。
  const ensureAmbientRuntime = useCallback(async () => {
    await setAmbientEnabledFlag(true);
    await resumeAmbientIfEnabled(userId);
  }, [userId]);

  const runAction = useCallback(async (action: Exclude<BusyAction, null>, fn: () => Promise<void>) => {
    setBusy(action);
    setError(null);
    try {
      await fn();
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refreshState]);

  const startScan = useCallback(() => runAction("scan", async () => {
    await PinHardware.requestPermissions();
    await PinHardware.startMonitoring();
    await PinHardware.startScan();
  }), [runAction]);

  const connectDevice = useCallback((deviceId: string) => runAction("connect", async () => {
    autoStartOnConnectRef.current = true;
    try {
      await PinHardware.requestPermissions();
      await PinHardware.startMonitoring();
      await PinHardware.connect({ deviceId });
    } catch (err) {
      autoStartOnConnectRef.current = false;
      throw err;
    }
  }), [runAction]);

  const startCapture = useCallback(() => runAction("capture", async () => {
    setTranscripts([]);
    let asrUrl: string | undefined;
    try {
      const token = await mintPinHardwareAsrToken();
      asrUrl = token.url;
    } catch (err) {
      if (err instanceof PinHardwareAsrNotConfiguredError) {
        // 服务端未配腾讯凭据:回退手机收录,不在已连接的设备上甩红错。
        setSource("phone");
        await syncSourceConsent({
          ...(phoneConsentEnabled ? {} : { sound_classifier: true }),
          ...(pinConsentEnabled ? { pin_hardware: false } : {}),
        });
        await ensureAmbientRuntime();
        setError(t("pinHardware.description.asrUnavailable"));
        return;
      }
      throw err;
    }
    // mint 成功才动 consent(ASR 故障不会把 pin_hardware 留在开启态);
    // 手机/硬件互斥:开硬件同一 patch 关手机源。
    await syncSourceConsent({
      ...(pinConsentEnabled ? {} : { pin_hardware: true }),
      ...(phoneConsentEnabled ? { sound_classifier: false } : {}),
    });
    await ensureAmbientRuntime();
    await PinHardware.requestPermissions();
    await PinHardware.startMonitoring();
    await PinHardware.startCapture(asrUrl ? { asrUrl } : undefined);
    setSource("pin");
  }), [ensureAmbientRuntime, phoneConsentEnabled, pinConsentEnabled, runAction, syncSourceConsent, t]);

  useEffect(() => {
    startCaptureRef.current = startCapture;
  }, [startCapture]);

  const disconnect = useCallback(() => runAction("disconnect", async () => {
    await PinHardware.stopCapture();
    await PinHardware.disconnect();
    await syncSourceConsent({ pin_hardware: false });
  }), [runAction, syncSourceConsent]);

  // tab 是纯视图切换:录制状态由 Ambient 页(手机)和连接生命周期(硬件)控制。
  const selectSource = useCallback((next: ActiveSource) => {
    setSource(next);
    setError(null);
  }, []);

  const toggleAutoReconnect = useCallback((enabled: boolean) => {
    void PinHardware.setAutoReconnect({ enabled })
      .then(refreshState)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshState]);

  const toggleMarkLine = useCallback((lineId: string) => {
    if (lineId.startsWith("phone:")) {
      setMarkedPhoneIds((prev) => {
        const next = new Set(prev);
        if (next.has(lineId)) next.delete(lineId);
        else next.add(lineId);
        return next;
      });
      return;
    }
    setTranscripts((prev) => prev.map((line) => (
      line.id === lineId ? { ...line, marked: line.marked !== true } : line
    )));
  }, []);

  const openManagement = useCallback(() => {
    // PIN 设备是本页第一公民:进来永远先落 PIN tab(手机流是次要视图,
    // 手动切换查看)。未连接且未采集时立即开扫——startScan 内含
    // requestPermissions + startMonitoring(记住的默认设备先走自动重连,
    // 失败回退扫描)。
    setSource("pin");
    setExpanded(true);
    if (state?.connected !== true && !captureRunningRef.current) {
      void startScan();
    }
  }, [startScan, state?.connected]);

  const openAmbientSources = useCallback(() => {
    setExpanded(false);
    onOpenAmbientSettings?.();
  }, [onOpenAmbientSettings]);

  const status = useMemo(() => summarizeState(t, state, pinConsentEnabled), [pinConsentEnabled, state, t]);

  return (
    <>
      <GlassCard style={styles.entryCard}>
        <Pressable onPress={openManagement} accessibilityRole="button" style={styles.entryRow}>
          <View style={styles.entryIconBox}>
            <Radio size={18} color={PINK_SOLID} />
          </View>
          <View style={styles.flex1MinW0}>
            <View style={styles.entryTitleRow}>
              <Text style={styles.entryTitle}>{t("pinHardware.title")}</Text>
              <StatusPill label={status.label} tone={status.tone} />
            </View>
            <Text style={styles.entrySubtitle} numberOfLines={2}>{status.description}</Text>
          </View>
          <View style={styles.manageChip}>
            <Text style={styles.manageChipText}>{t("pinHardware.manage")}</Text>
          </View>
        </Pressable>
        {error && !expanded ? <Text style={styles.errorText}>{error}</Text> : null}
      </GlassCard>

      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)}>
        <ManagementPage
          state={state}
          status={status}
          transcripts={transcripts}
          phoneTranscripts={phoneTranscripts}
          phoneSourceReady={phoneReady}
          source={source}
          busy={busy}
          error={error}
          onClose={() => setExpanded(false)}
          onScan={startScan}
          onStartCapture={startCapture}
          onConnect={connectDevice}
          onDisconnect={disconnect}
          onToggleMark={toggleMarkLine}
          onRefresh={refreshState}
          onSelectSource={selectSource}
          onToggleAutoReconnect={toggleAutoReconnect}
          onOpenAmbientSources={openAmbientSources}
        />
      </Modal>
    </>
  );
}

// ── 管理页 ──────────────────────────────────────────────────────────────

function ManagementPage({
  state,
  status,
  transcripts,
  phoneTranscripts,
  phoneSourceReady,
  source,
  busy,
  error,
  onClose,
  onScan,
  onStartCapture,
  onConnect,
  onDisconnect,
  onToggleMark,
  onRefresh,
  onSelectSource,
  onToggleAutoReconnect,
  onOpenAmbientSources,
}: {
  state: PinHardwareState | null;
  status: { label: string; description: string; tone: StatusTone };
  transcripts: TranscriptLine[];
  phoneTranscripts: TranscriptLine[];
  phoneSourceReady: boolean;
  source: ActiveSource;
  busy: BusyAction;
  error: string | null;
  onClose: () => void;
  onScan: () => void;
  onStartCapture: () => void;
  onConnect: (deviceId: string) => void;
  onDisconnect: () => void;
  onToggleMark: (lineId: string) => void;
  onRefresh: () => void;
  onSelectSource: (next: ActiveSource) => void;
  onToggleAutoReconnect: (enabled: boolean) => void;
  onOpenAmbientSources: () => void;
}) {
  const { t } = useTranslation("connect");
  const insets = useSafeAreaInsets();
  const connected = state?.connected === true;
  const pinCaptureRunning = connected && state?.captureRunning === true;
  const connectStep = state?.status === "connecting" || state?.status === "connect_retrying"
    ? 0
    : state?.status === "discovering_services"
      ? 1
      : state?.status === "capture_starting"
        ? 2
        : null;

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <StaticVideoBackdrop />
      {/* header */}
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("pinHardware.back")}
          style={styles.backButton}
        >
          <ArrowLeft size={17} color={fg(0.7)} />
        </Pressable>
        <View style={styles.flex1MinW0}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {source === "phone" || pinCaptureRunning
              ? t("pinHardware.liveTitle")
              : t("pinHardware.manageTitle")}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {source === "phone"
              ? t("pinHardware.source.phone")
              : connected
                ? state?.deviceName ?? t("pinHardware.deviceNameFallback")
                : t("pinHardware.manageSubtitle")}
          </Text>
        </View>
        <StatusPill label={status.label} tone={status.tone} />
      </View>

      {/* 固定 tab:纯视图切换。PIN 设备在前——本页优先管理 PIN 硬件。 */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        <SourceTab
          icon={<Radio size={15} color={source === "pin" ? PINK_TEXT : fg(0.35)} />}
          label={t("pinHardware.source.pinDevice")}
          active={source === "pin"}
          onPress={() => onSelectSource("pin")}
        />
        <SourceTab
          icon={<Smartphone size={15} color={source === "phone" ? PINK_TEXT : fg(0.35)} />}
          label={t("pinHardware.source.phone")}
          active={source === "phone"}
          onPress={() => onSelectSource("phone")}
        />
      </View>

      {connectStep != null ? <ConnectStepper active={connectStep} /> : null}

      <View style={styles.content}>
        {source === "phone" ? (
          <PhoneLiveView
            transcripts={phoneTranscripts}
            phoneSourceReady={phoneSourceReady}
            pinCaptureRunning={pinCaptureRunning}
            onToggleMark={onToggleMark}
            onOpenAmbientSources={onOpenAmbientSources}
            onViewPinDevice={() => onSelectSource("pin")}
          />
        ) : connected ? (
          <ConnectedView
            state={state}
            status={status}
            busy={busy}
            transcripts={transcripts}
            pinCaptureRunning={pinCaptureRunning}
            onStartCapture={onStartCapture}
            onDisconnect={onDisconnect}
            onToggleAutoReconnect={onToggleAutoReconnect}
            onToggleMark={onToggleMark}
          />
        ) : (
          <ScanView state={state} status={status} busy={busy} onScan={onScan} onConnect={onConnect} />
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      {source === "pin" ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            onPress={onDisconnect}
            disabled={busy !== null || !connected}
            accessibilityRole="button"
            style={[styles.footerGhostButton, (busy !== null || !connected) && styles.disabled]}
          >
            {busy === "disconnect" ? <Spinner size={13} color={fg(0.6)} /> : <Unplug size={13} color={fg(0.6)} />}
            <Text style={styles.footerGhostText}>{t("pinHardware.disconnect")}</Text>
          </Pressable>
          <Pressable onPress={onRefresh} accessibilityRole="button" style={styles.footerPinkButton}>
            <Text style={styles.footerPinkText}>{t("pinHardware.refresh")}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// ── 子视图 ──────────────────────────────────────────────────────────────

function ScanView({
  state,
  status,
  busy,
  onScan,
  onConnect,
}: {
  state: PinHardwareState | null;
  status: { label: string; description: string; tone: StatusTone };
  busy: BusyAction;
  onScan: () => void;
  onConnect: (deviceId: string) => void;
}) {
  const { t } = useTranslation("connect");
  const scanning = state?.scanning === true;
  const devices = state?.devices ?? [];
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <GlassCard style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>{t("pinHardware.scanHeroTitle")}</Text>
        <Text style={styles.sectionDesc}>{status.description}</Text>
        <Pressable
          onPress={onScan}
          disabled={busy === "scan"}
          accessibilityRole="button"
          style={[styles.primaryOutlineButton, busy === "scan" && styles.disabled]}
        >
          {busy === "scan" ? <Spinner size={15} color={PINK_TEXT} /> : <RefreshCw size={15} color={PINK_TEXT} />}
          <Text style={styles.primaryOutlineText}>
            {scanning ? t("pinHardware.scanning") : t("pinHardware.scan")}
          </Text>
        </Pressable>
      </GlassCard>

      {devices.length === 0 ? (
        <GlassCard style={styles.emptyCard}>
          <View style={styles.emptyIconCircle}>
            {scanning ? <Spinner size={18} color={PINK_SOLID} /> : <Bluetooth size={18} color={PINK_SOLID} />}
          </View>
          <Text style={styles.emptyTitle}>
            {scanning ? t("pinHardware.scanningEmptyTitle") : t("pinHardware.noDevicesTitle")}
          </Text>
          <Text style={styles.emptyHint}>
            {scanning ? t("pinHardware.scanningEmptyHint") : t("pinHardware.noDevices")}
          </Text>
        </GlassCard>
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={styles.listLabel}>{t("pinHardware.nearbyDevices")}</Text>
          {devices.map((device, index) => {
            const isConnected = device.connected || device.id === state?.deviceId;
            return (
              <Animated.View key={device.id} entering={FadeInDown.duration(300).delay(index * 40)}>
                <GlassCard style={styles.deviceRow}>
                  <View style={styles.flex1MinW0}>
                    <Text style={styles.deviceName} numberOfLines={1}>{device.name}</Text>
                    <Text style={styles.deviceMeta}>
                      {device.rssi == null ? device.id : t("pinHardware.rssi", { value: device.rssi })}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => onConnect(device.id)}
                    disabled={busy === "connect" || isConnected}
                    accessibilityRole="button"
                    style={[styles.connectChip, (busy === "connect" || isConnected) && styles.disabled]}
                  >
                    {busy === "connect" ? <Spinner size={11} color={PINK_TEXT} /> : null}
                    <Text style={styles.connectChipText}>
                      {busy === "connect"
                        ? t("pinHardware.connecting")
                        : isConnected
                          ? t("pinHardware.connected")
                          : t("pinHardware.connectDevice")}
                    </Text>
                  </Pressable>
                </GlassCard>
              </Animated.View>
            );
          })}
        </View>
      )}

      <GlassCard style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>{t("pinHardware.educationTitle")}</Text>
        <Text style={styles.sectionDesc}>{t("pinHardware.educationDesc")}</Text>
      </GlassCard>
    </ScrollView>
  );
}

function ConnectedView({
  state,
  status,
  busy,
  transcripts,
  pinCaptureRunning,
  onStartCapture,
  onDisconnect,
  onToggleAutoReconnect,
  onToggleMark,
}: {
  state: PinHardwareState | null;
  status: { label: string; description: string; tone: StatusTone };
  busy: BusyAction;
  transcripts: TranscriptLine[];
  pinCaptureRunning: boolean;
  onStartCapture: () => void;
  onDisconnect: () => void;
  onToggleAutoReconnect: (enabled: boolean) => void;
  onToggleMark: (lineId: string) => void;
}) {
  const { t } = useTranslation("connect");
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <GlassCard style={styles.sectionCard}>
        <View style={styles.overviewRow}>
          <View style={styles.flex1MinW0}>
            <Text style={styles.overviewName} numberOfLines={1}>
              {state?.deviceName ?? t("pinHardware.deviceNameFallback")}
            </Text>
            <View style={styles.overviewStatusRow}>
              <StatusPill label={status.label} tone={status.tone} />
            </View>
            <Text style={styles.sectionDesc}>{status.description}</Text>
          </View>
        </View>
        <View style={styles.metricsRow}>
          <Metric
            icon={<BatteryMedium size={16} color={PINK_SOLID} />}
            value={state?.batteryPercent == null ? t("pinHardware.metrics.batteryUnknown") : `${state.batteryPercent}%`}
            label={t("pinHardware.metrics.battery")}
          />
          <Metric
            icon={<Bluetooth size={16} color={PINK_SOLID} />}
            value={t(`pinHardware.bluetooth.${state?.bluetoothState ?? "unknown"}`, { defaultValue: state?.bluetoothState ?? "—" })}
            label={t("pinHardware.metrics.bluetooth")}
          />
          <Metric
            icon={<RefreshCw size={16} color={PINK_SOLID} />}
            value={state?.firmwareVersion ?? t("pinHardware.settings.unreported")}
            label={t("pinHardware.metrics.firmware")}
          />
        </View>
      </GlassCard>

      {pinCaptureRunning ? (
        <>
          <CaptureBanner label={t("pinHardware.capturingViaDevice")} icon={<Bluetooth size={16} color="#fff" />} />
          <TranscriptPanel
            transcripts={transcripts}
            emptyLabel={t("pinHardware.emptyTranscript")}
            onToggleMark={onToggleMark}
            anchor="bottom"
            maxHeight={360}
          />
        </>
      ) : (
        <Pressable
          onPress={onStartCapture}
          disabled={busy !== null}
          accessibilityRole="button"
          style={[styles.primarySolidButton, busy !== null && styles.disabled]}
        >
          {busy === "capture" ? <Spinner size={15} color="#fff" /> : <Play size={15} color="#fff" fill="#fff" />}
          <Text style={styles.primarySolidText}>{t("pinHardware.startCapture")}</Text>
        </Pressable>
      )}

      <GlassCard style={{ padding: 0 }}>
        <View style={styles.settingRow}>
          <View style={styles.settingIconCircle}>
            <Check size={16} color={PINK_SOLID} />
          </View>
          <View style={styles.flex1MinW0}>
            <Text style={styles.settingTitle}>{t("pinHardware.settings.defaultDevice")}</Text>
            <Text style={styles.settingDesc} numberOfLines={2}>{t("pinHardware.settings.defaultDeviceDesc")}</Text>
          </View>
          <Switch
            value={state?.autoReconnect !== false}
            onValueChange={onToggleAutoReconnect}
            disabled={busy !== null}
            trackColor={{ true: PINK_SOLID }}
            accessibilityLabel={t("pinHardware.settings.defaultDevice")}
          />
        </View>
        <Pressable onPress={onDisconnect} disabled={busy !== null} accessibilityRole="button" style={styles.settingRow}>
          <View style={[styles.settingIconCircle, { backgroundColor: "rgba(239,68,68,0.1)" }]}>
            {busy === "disconnect" ? <Spinner size={16} color="#ef4444" /> : <Unplug size={16} color="#ef4444" />}
          </View>
          <View style={styles.flex1MinW0}>
            <Text style={styles.settingTitle}>{t("pinHardware.disconnect")}</Text>
            <Text style={styles.settingDesc} numberOfLines={2}>{t("pinHardware.settings.disconnectDesc")}</Text>
          </View>
          <ChevronRight size={16} color={fg(0.35)} />
        </Pressable>
      </GlassCard>
    </ScrollView>
  );
}

function PhoneLiveView({
  transcripts,
  phoneSourceReady,
  pinCaptureRunning,
  onToggleMark,
  onOpenAmbientSources,
  onViewPinDevice,
}: {
  transcripts: TranscriptLine[];
  phoneSourceReady: boolean;
  /** PIN 硬件是否正在收录——手机/硬件互斥,收录来源必须显式表达。 */
  pinCaptureRunning: boolean;
  onToggleMark: (lineId: string) => void;
  onOpenAmbientSources: () => void;
  onViewPinDevice: () => void;
}) {
  const { t } = useTranslation("connect");
  const lines: TranscriptLine[] = phoneSourceReady
    ? [
      { id: "phone:listening", speaker: "", text: t("pinHardware.listening"), capturedAt: "", placeholder: true },
      ...transcripts,
    ]
    : transcripts;
  // 三种收录状态,横幅/空态各自表达:手机在录(绿活跃横幅)、PIN 设备在录
  // (中性提示条,收录不在手机这边)、都没录(空态+去开启 CTA)。
  return (
    <View style={styles.phoneView}>
      {phoneSourceReady ? (
        <CaptureBanner label={t("pinHardware.capturingViaPhone")} icon={<Smartphone size={16} color="#fff" />} />
      ) : pinCaptureRunning ? (
        <View style={styles.sourceNoticeBar}>
          <Radio size={15} color={PINK_TEXT} />
          <Text style={styles.sourceNoticeText} numberOfLines={2}>
            {t("pinHardware.phoneIdlePinActive")}
          </Text>
        </View>
      ) : null}
      <TranscriptPanel
        transcripts={lines}
        anchor="top"
        emptyLabel={pinCaptureRunning
          ? t("pinHardware.phoneIdlePinActive")
          : t("pinHardware.emptyTranscriptPhoneDisabled")}
        emptyAction={phoneSourceReady ? null : pinCaptureRunning ? (
          <Pressable onPress={onViewPinDevice} accessibilityRole="button" style={styles.ctaChip}>
            <Text style={styles.ctaChipText}>{t("pinHardware.viewPinDevice")}</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onOpenAmbientSources} accessibilityRole="button" style={styles.ctaChip}>
            <Text style={styles.ctaChipText}>{t("pinHardware.openAmbientSources")}</Text>
          </Pressable>
        )}
        onToggleMark={onToggleMark}
        fill
      />
    </View>
  );
}

function TranscriptPanel({
  transcripts,
  emptyLabel,
  emptyAction,
  onToggleMark,
  anchor,
  fill = false,
  maxHeight,
}: {
  transcripts: TranscriptLine[];
  emptyLabel: string;
  emptyAction?: ReactNode;
  onToggleMark: (lineId: string) => void;
  anchor: "top" | "bottom";
  fill?: boolean;
  maxHeight?: number;
}) {
  const { t } = useTranslation("connect");
  const scrollRef = useRef<ScrollView | null>(null);
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (anchor !== "bottom") return;
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [transcripts, anchor]);

  return (
    <GlassCard style={[styles.panel, fill ? styles.flex1 : null, maxHeight != null ? { maxHeight } : null]}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("pinHardware.transcriptTitle")}</Text>
        <StatusPill label={t("pinHardware.live")} tone="active" />
      </View>
      {transcripts.length === 0 ? (
        <View style={styles.panelEmpty}>
          <View style={styles.emptyIconCircle}>
            <Mic size={18} color={PINK_SOLID} />
          </View>
          <Text style={styles.emptyHint}>{emptyLabel}</Text>
          {emptyAction}
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            stickToBottomRef.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height < 48;
          }}
          scrollEventThrottle={100}
          style={styles.flex1}
        >
          {transcripts.map((line, index) => (line.placeholder ? (
            <View key={line.id} style={[styles.line, index < transcripts.length - 1 && styles.lineBorder]}>
              <View style={styles.listeningIconCircle}>
                <Mic size={15} color={PINK_SOLID} />
              </View>
              <Text style={styles.listeningText}>{line.text}</Text>
            </View>
          ) : (
            <Animated.View
              key={line.id}
              entering={(anchor === "bottom" ? FadeInDown : FadeInUp).duration(300)}
              style={[styles.line, index < transcripts.length - 1 && styles.lineBorder]}
            >
              <View style={[styles.avatar, line.speaker === "PINAI" || line.speaker === "我" ? styles.avatarSelf : styles.avatarOther]}>
                <Text style={[styles.avatarText, (line.speaker === "PINAI" || line.speaker === "我") && { color: "#fff" }]}>
                  {speakerInitial(line.speaker)}
                </Text>
              </View>
              <View style={styles.flex1MinW0}>
                <View style={styles.lineMetaRow}>
                  <Text style={styles.lineSpeaker}>{line.speaker}</Text>
                  <Text style={styles.lineTime}>{formatTime(line.capturedAt)}</Text>
                </View>
                <Text style={[styles.lineText, line.pending && styles.lineTextPending]}>
                  {line.text}{line.pending ? " …" : ""}
                </Text>
              </View>
              <Pressable
                onPress={() => onToggleMark(line.id)}
                accessibilityRole="button"
                accessibilityLabel={t("pinHardware.markImportant")}
                accessibilityState={{ selected: line.marked === true }}
                hitSlop={8}
                style={styles.markButton}
              >
                <Bookmark
                  size={15}
                  color={line.marked ? PINK_SOLID : fg(0.25)}
                  fill={line.marked ? PINK_SOLID : "transparent"}
                />
              </Pressable>
            </Animated.View>
          )))}
        </ScrollView>
      )}
    </GlassCard>
  );
}

function ConnectStepper({ active }: { active: number }) {
  const { t } = useTranslation("connect");
  const labels = [
    t("pinHardware.steps.connect"),
    t("pinHardware.steps.discover"),
    t("pinHardware.steps.transcribe"),
  ];
  return (
    <Animated.View entering={FadeInDown.duration(240)}>
      <GlassCard style={styles.stepper}>
        {labels.map((label, index) => {
          const done = index < active;
          const current = index === active;
          return (
            <View key={label} style={styles.stepItemWrap}>
              {index > 0 ? (
                <View style={[styles.stepLine, (done || current) && { backgroundColor: pink(0.4) }]} />
              ) : null}
              <View style={styles.stepItem}>
                <View
                  style={[
                    styles.stepCircle,
                    done && { backgroundColor: PINK_SOLID, borderColor: PINK_SOLID },
                    current && { borderColor: pink(0.6) },
                  ]}
                >
                  {done ? (
                    <Check size={10} color="#fff" strokeWidth={3} />
                  ) : (
                    <Text style={[styles.stepNum, current && { color: PINK_TEXT }]}>{index + 1}</Text>
                  )}
                </View>
                <Text style={[styles.stepLabel, current && { color: PINK_TEXT, fontFamily: "Inter_600SemiBold" }, done && { color: fg(0.6) }]}>
                  {label}
                </Text>
              </View>
            </View>
          );
        })}
      </GlassCard>
    </Animated.View>
  );
}

function CaptureBanner({ label, icon }: { label: string; icon: ReactNode }) {
  return (
    <View style={styles.banner}>
      <View style={styles.bannerDot} />
      <Text style={styles.bannerText} numberOfLines={1}>{label}</Text>
      {icon}
    </View>
  );
}

function SourceTab({
  icon,
  label,
  active,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.tab, active && styles.tabActive]}
    >
      {icon}
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Metric({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <View style={styles.metric}>
      {icon}
      <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.metricLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  const palette = {
    ok: { bg: "rgba(16,185,129,0.1)", color: "#047857" },
    active: { bg: pink(0.12), color: PINK_TEXT },
    warn: { bg: "rgba(245,158,11,0.1)", color: "#b45309" },
    muted: { bg: fg(0.06), color: fg(0.5) },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }]}>
      <Text style={[styles.pillText, { color: palette.color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// ── 样式 ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  flex1MinW0: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.45 },
  errorText: {
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: "rgba(239,68,68,0.1)",
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
    color: "rgba(239,68,68,0.9)",
  },

  entryCard: { padding: 12 },
  entryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  entryIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: pink(0.12),
    alignItems: "center",
    justifyContent: "center",
  },
  entryTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  entryTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  entrySubtitle: { marginTop: 2, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.5) },
  manageChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: pink(0.3),
    backgroundColor: pink(0.1),
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  manageChipText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },

  page: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: fg(0.08),
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: fg(0.1),
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 15, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  headerSubtitle: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.45) },

  tabBar: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    backgroundColor: fg(0.05),
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 40,
    borderRadius: 12,
  },
  tabActive: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  tabText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: fg(0.35) },
  tabTextActive: { color: PINK_TEXT },

  stepper: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginTop: 10, paddingHorizontal: 14, paddingVertical: 10 },
  stepItemWrap: { flexDirection: "row", alignItems: "center", flex: 1 },
  stepLine: { flex: 1, height: 1, backgroundColor: fg(0.1), marginHorizontal: 6 },
  stepItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  stepCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: fg(0.15),
    alignItems: "center",
    justifyContent: "center",
  },
  stepNum: { fontSize: 10, lineHeight: 13, fontFamily: "Inter_600SemiBold", color: fg(0.3) },
  stepLabel: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.35) },

  content: { flex: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 12 },
  scrollContent: { gap: 12, paddingBottom: 16 },
  phoneView: { flex: 1, minHeight: 0, gap: 12, paddingBottom: 12 },

  sectionCard: { padding: 14, gap: 8 },
  sectionTitle: { fontSize: 14, lineHeight: 19, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  sectionDesc: { fontSize: 12, lineHeight: 17, fontFamily: "Inter_400Regular", color: fg(0.5) },

  primaryOutlineButton: {
    marginTop: 4,
    minHeight: 44,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: pink(0.25),
    backgroundColor: pink(0.08),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryOutlineText: { fontSize: 13, lineHeight: 17, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },
  primarySolidButton: {
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: PINK_SOLID,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primarySolidText: { fontSize: 14, lineHeight: 18, fontFamily: "Inter_600SemiBold", color: "#fff" },

  emptyCard: { padding: 20, alignItems: "center", gap: 8 },
  emptyIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: pink(0.1),
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { fontSize: 13, lineHeight: 17, fontFamily: "Inter_600SemiBold", color: fg(0.65) },
  emptyHint: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_400Regular",
    color: fg(0.45),
    textAlign: "center",
    maxWidth: 280,
  },
  listLabel: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: "Inter_600SemiBold",
    color: fg(0.4),
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  deviceName: { fontSize: 13, lineHeight: 17, fontFamily: "Inter_600SemiBold", color: fg(0.75) },
  deviceMeta: { marginTop: 1, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },
  connectChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: pink(0.3),
    backgroundColor: pink(0.12),
    paddingHorizontal: 10,
    minHeight: 32,
  },
  connectChipText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },

  overviewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  overviewName: { fontSize: 17, lineHeight: 22, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  overviewStatusRow: { flexDirection: "row", marginTop: 4, marginBottom: 4 },
  metricsRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  metric: {
    flex: 1,
    alignItems: "center",
    gap: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.06),
    backgroundColor: "rgba(255,255,255,0.45)",
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  metricValue: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_600SemiBold", color: fg(0.75) },
  metricLabel: { fontSize: 9, lineHeight: 12, fontFamily: "Inter_400Regular", color: fg(0.4) },

  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: fg(0.06),
  },
  settingIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: pink(0.08),
    alignItems: "center",
    justifyContent: "center",
  },
  settingTitle: { fontSize: 13, lineHeight: 17, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  settingDesc: { marginTop: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.45) },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    backgroundColor: PINK_SOLID,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  bannerDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  bannerText: { flex: 1, fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: "#fff" },

  panel: { padding: 12, minHeight: 160 },
  panelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  panelTitle: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: fg(0.75) },
  panelEmpty: { alignItems: "center", gap: 8, paddingVertical: 28 },
  line: { flexDirection: "row", gap: 10, paddingVertical: 12, alignItems: "flex-start" },
  lineBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: fg(0.06) },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  avatarSelf: { backgroundColor: PINK_SOLID },
  avatarOther: { backgroundColor: "rgba(14,165,233,0.14)" },
  avatarText: { fontSize: 11, lineHeight: 14, fontFamily: "Inter_600SemiBold", color: "#0369a1" },
  lineMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 },
  lineSpeaker: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_600SemiBold", color: "#1e4f91" },
  lineTime: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },
  lineText: { fontSize: 13, lineHeight: 19, fontFamily: "Inter_400Regular", color: fg(0.85) },
  lineTextPending: { color: fg(0.5), fontStyle: "italic" },
  markButton: { alignSelf: "center", padding: 6 },
  listeningIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: pink(0.1),
    alignItems: "center",
    justifyContent: "center",
  },
  listeningText: { alignSelf: "center", fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", fontStyle: "italic", color: fg(0.5) },

  sourceNoticeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: pink(0.25),
    backgroundColor: pink(0.08),
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sourceNoticeText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "Inter_500Medium",
    color: PINK_TEXT,
  },
  ctaChip: {
    marginTop: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: pink(0.3),
    backgroundColor: pink(0.1),
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: "center",
  },
  ctaChipText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },

  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: fg(0.08),
  },
  footerGhostButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 42,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: fg(0.1),
    paddingHorizontal: 16,
  },
  footerGhostText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: fg(0.6) },
  footerPinkButton: {
    minHeight: 42,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: pink(0.35),
    backgroundColor: pink(0.14),
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  footerPinkText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },

  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 160 },
  pillText: { fontSize: 10, lineHeight: 13, fontFamily: "Inter_600SemiBold" },
});
