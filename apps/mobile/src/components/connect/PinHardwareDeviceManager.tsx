/**
 * PIN 硬件(MR20 录音器)入口卡 + 全屏管理页——web(已退役 Capacitor 前端)
 * PinHardwareDeviceManager/PinHardwareManagementPage 的 RN 介质版,交互模型
 * 一致:
 * - PIN 设备是默认主流程:未连接自动扫描,连接成功自动开始转录
 * - 设备状态压成轻量信息条;详情/自动重连/断开收进底部 sheet
 * - 设备收录中只展示硬件转录;停止后手机麦克风接管并显示手机转录
 * - 互斥:开始硬件转录时同一 consent patch 关手机源
 * - 逐行标记;关键节点触感反馈
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  useReducedMotion,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowLeft,
  Bluetooth,
  Bookmark,
  ChevronRight,
  Mic,
  Play,
  Radio,
  RefreshCw,
  Smartphone,
  Square,
  Unplug,
  X,
} from "lucide-react-native";
import type { EventSubscription } from "expo-modules-core";
import { mintPinHardwareAsrToken, PinHardwareAsrNotConfiguredError } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import {
  PinHardware,
  type PinHardwareState,
} from "../../../modules/pin-hardware";
import { useAmbientLiveSession } from "../../hooks/useAmbientLiveSession";
import {
  getAmbientEnabledSnapshot,
  resumeAmbientIfEnabled,
  setAmbientEnabledFlag,
  subscribeAmbientEnabled,
} from "../../ambient/runtime";
import type { LiveSessionData } from "../../ambient/live/live-session";
import {
  getPinHardwareTranscriptSnapshot,
  mergeTranscriptEvent,
  setPinHardwareTranscriptOwner,
  subscribePinHardwareTranscripts,
  togglePinHardwareTranscriptMark,
  type TranscriptLine,
} from "../../ambient/live/pin-hardware-transcript-store";
import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";
import { EM_TIGHT, tracking } from "../../ui/typography";
import { StaticVideoBackdrop } from "../../ui/VideoBackdrop";
import {
  hasConnectedPinPeripheral,
  isPinHardwareScanning,
} from "./pin-hardware-connection-state";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;
/** 品红主题色 hsl(304 75% 63%) ≈ rgb(231,90,222);深字 48% ≈ rgb(199,31,187)。 */
const PINK = "231,90,222";
const pink = (a: number) => `rgba(${PINK},${a})`;
const PINK_SOLID = "rgb(199,31,187)";
const PINK_TEXT = "rgb(158,25,148)";

const PHONE_TRANSCRIPT_MAX = 120;

export { mergeTranscriptEvent };
export type { TranscriptLine };

type ActiveSource = "phone" | "pin";
type BusyAction = "scan" | "connect" | "capture" | "stop" | "disconnect" | null;
type StatusTone = "ok" | "active" | "warn" | "muted";

// ── 纯函数(与 web 版同语义) ─────────────────────────────────────────────

export function summarizeState(
  t: TFunction<"connect">,
  state: PinHardwareState | null,
  enabled: boolean,
): { label: string; description: string; tone: StatusTone } {
  const peripheralConnected = hasConnectedPinPeripheral(state);
  if (!enabled && !peripheralConnected && state?.captureRunning !== true) {
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
  if (state.status === "capture_start_failed") {
    return {
      label: t("pinHardware.status.captureStartFailed"),
      description: t("pinHardware.description.captureStartFailed"),
      tone: "warn",
    };
  }
  if (state.captureRunning) {
    return {
      label: t("pinHardware.status.capturing"),
      description: t("pinHardware.description.capturing", { name: state.deviceName ?? t("pinHardware.deviceNameFallback") }),
      tone: "active",
    };
  }
  if (state.status === "capture_starting" || state.status === "device_capture_requested") {
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
  if (peripheralConnected) {
    return {
      label: t("pinHardware.status.connecting"),
      description: t("pinHardware.description.connecting", { name: state.deviceName ?? t("pinHardware.deviceNameFallback") }),
      tone: "active",
    };
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

function transcriptionPhase(
  t: TFunction<"connect">,
  state: PinHardwareState | null,
  transcriptCount: number,
): { label: string; emptyLabel: string; tone: StatusTone } {
  if (state?.status === "asr_error" || state?.asrState === "error") {
    return {
      label: t("pinHardware.status.asrError"),
      emptyLabel: t("pinHardware.description.asrError"),
      tone: "warn",
    };
  }
  if (state?.asrState === "connecting") {
    return {
      label: t("pinHardware.status.asrConnecting"),
      emptyLabel: t("pinHardware.description.asrConnecting"),
      tone: "active",
    };
  }
  if (transcriptCount > 0) {
    return { label: t("pinHardware.live"), emptyLabel: "", tone: "active" };
  }
  if ((state?.audioBytesReceived ?? 0) > 0) {
    return {
      label: t("pinHardware.status.recognizing"),
      emptyLabel: t("pinHardware.recognizingAudio"),
      tone: "active",
    };
  }
  return {
    label: t("pinHardware.status.waitingAudio"),
    emptyLabel: t("pinHardware.waitingAudio"),
    tone: "muted",
  };
}

/** Live 同一条管线的数据 → 手机接管后的转录行;Listening 占位由视图渲染。 */
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

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function displaySpeaker(
  t: TFunction<"connect">,
  speaker: string,
  deviceName?: string,
): string {
  const normalized = speaker.trim();
  if (!normalized || normalized === "PINAI" || normalized === deviceName) {
    return t("pinHardware.speakerLabel", { number: "A" });
  }
  const speakerMatch = /^Speaker\s+(.+)$/i.exec(normalized);
  if (speakerMatch?.[1]) {
    if (speakerMatch[1] === "?") return t("pinHardware.speakerUnknown");
    return t("pinHardware.speakerLabel", { number: speakerMatch[1] });
  }
  return normalized;
}

function speakerInitial(label: string): string {
  const normalized = label.trim();
  const speakerMatch = /^Speaker\s+(.+)$/i.exec(normalized);
  if (speakerMatch?.[1]) return speakerMatch[1] === "?" ? "…" : speakerMatch[1];
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
  const transcripts = useSyncExternalStore(
    subscribePinHardwareTranscripts,
    getPinHardwareTranscriptSnapshot,
  );
  const [markedPhoneIds, setMarkedPhoneIds] = useState<ReadonlySet<string>>(new Set());
  const [source, setSource] = useState<ActiveSource>("pin");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const captureRunningRef = useRef(false);
  const connectedRef = useRef(false);
  // 显式点连接才置位:连上即自动开始转录;后台自动重连(默认设备)不置位——
  // 无用户动作不静默开录。
  const autoStartOnConnectRef = useRef(false);
  const startCaptureRef = useRef<(() => Promise<void>) | null>(null);
  const deviceCaptureRequestHandledRef = useRef(false);

  const pinConsentEnabled = settings?.ambientSources?.pin_hardware?.enabled === true;
  const phoneConsentEnabled = settings?.ambientSources?.sound_classifier?.enabled === true;
  // 本机主闸(per-device opt-in):consent 只是授权记录,主闸关着没有任何源在录。
  // 只看 consent 会在隐私敏感面上显示假的「正在录制」指示。
  const deviceGateOpen = useSyncExternalStore(subscribeAmbientEnabled, getAmbientEnabledSnapshot) === true;
  const phoneReady = deviceGateOpen && phoneConsentEnabled;

  useEffect(() => {
    void setPinHardwareTranscriptOwner(userId);
  }, [userId]);

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
    void (async () => {
      try {
        stateSub = PinHardware.addListener("pinHardwareState", (event: PinHardwareState) => {
          const wasConnected = connectedRef.current;
          const isConnected = event.connected === true;
          connectedRef.current = isConnected;
          const isCapturing = isConnected && event.captureRunning === true;
          const captureJustStarted = !captureRunningRef.current && isCapturing;
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
        const current = await PinHardware.getState();
        connectedRef.current = current.connected === true;
        captureRunningRef.current = current.connected === true && current.captureRunning === true;
        if (mounted) setState(current);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
      stateSub?.remove();
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
    let asrUrl: string;
    try {
      const token = await mintPinHardwareAsrToken({ speakerContextId: state?.speakerContextId });
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
    await PinHardware.startCapture({ asrUrl });
    setSource("pin");
  }), [ensureAmbientRuntime, phoneConsentEnabled, pinConsentEnabled, runAction, state?.speakerContextId, syncSourceConsent, t]);

  useEffect(() => {
    startCaptureRef.current = startCapture;
  }, [startCapture]);

  useEffect(() => {
    if (state?.status !== "device_capture_requested") {
      deviceCaptureRequestHandledRef.current = false;
      return;
    }
    if (deviceCaptureRequestHandledRef.current) return;
    deviceCaptureRequestHandledRef.current = true;
    void startCapture();
  }, [startCapture, state?.status]);

  const disconnect = useCallback(() => runAction("disconnect", async () => {
    await PinHardware.stopCapture();
    await PinHardware.disconnect();
    setSource("phone");
    await syncSourceConsent({ pin_hardware: false, sound_classifier: true });
    await ensureAmbientRuntime();
  }), [ensureAmbientRuntime, runAction, syncSourceConsent]);

  const stopCapture = useCallback(() => runAction("stop", async () => {
    await PinHardware.stopCapture();
    setSource("phone");
    await syncSourceConsent({ pin_hardware: false, sound_classifier: true });
    await ensureAmbientRuntime();
  }), [ensureAmbientRuntime, runAction, syncSourceConsent]);

  const openPinFlow = useCallback(() => {
    setSource("pin");
    setError(null);
    if (!hasConnectedPinPeripheral(state) && state?.scanning !== true) {
      void startScan();
    }
  }, [startScan, state]);

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
    togglePinHardwareTranscriptMark(lineId);
  }, []);

  const openManagement = useCallback(() => {
    // PIN 设备是本页第一公民:进来永远先落设备流程。未连接且未采集时
    // 立即开扫——startScan 内含
    // requestPermissions + startMonitoring(记住的默认设备先走自动重连,
    // 失败回退扫描)。
    setSource("pin");
    setExpanded(true);
    if (!hasConnectedPinPeripheral(state) && !captureRunningRef.current) {
      void startScan();
    }
  }, [startScan, state]);

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
          onStopCapture={stopCapture}
          onConnect={connectDevice}
          onDisconnect={disconnect}
          onToggleMark={toggleMarkLine}
          onOpenPinFlow={openPinFlow}
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
  onStopCapture,
  onConnect,
  onDisconnect,
  onToggleMark,
  onOpenPinFlow,
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
  onStopCapture: () => void;
  onConnect: (deviceId: string) => void;
  onDisconnect: () => void;
  onToggleMark: (lineId: string) => void;
  onOpenPinFlow: () => void;
  onToggleAutoReconnect: (enabled: boolean) => void;
  onOpenAmbientSources: () => void;
}) {
  const { t } = useTranslation("connect");
  const insets = useSafeAreaInsets();
  const [deviceDetailsOpen, setDeviceDetailsOpen] = useState(false);
  const connected = hasConnectedPinPeripheral(state);
  const pinCaptureRunning = state?.connected === true && state.captureRunning === true;
  const pinJourneyActive = pinCaptureRunning
    || state?.scanning === true
    || busy === "scan"
    || busy === "connect"
    || busy === "capture"
    || busy === "stop"
    || busy === "disconnect"
    || state?.status === "connecting"
    || state?.status === "connect_retrying"
    || state?.status === "discovering_services"
    || state?.status === "capture_starting"
    || state?.status === "device_capture_requested"
    || state?.status === "waiting_for_device";
  const activeSource: ActiveSource = pinJourneyActive ? "pin" : source;
  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <StaticVideoBackdrop />
      {/* header */}
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("pinHardware.back")}
          hitSlop={4}
          style={styles.backButton}
        >
          <ArrowLeft size={20} color={fg(0.78)} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{t("pinHardware.liveTitle")}</Text>
      </View>

      <DeviceStatusBar
        state={state}
        status={status}
        busy={busy}
        activeSource={activeSource}
        onOpenDetails={() => setDeviceDetailsOpen(true)}
        onOpenPinFlow={onOpenPinFlow}
        onScan={onScan}
      />

      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom + 8, 16) }]}>
        {activeSource === "phone" ? (
          <PhoneLiveView
            transcripts={phoneTranscripts}
            phoneSourceReady={phoneSourceReady}
            pinCaptureRunning={pinCaptureRunning}
            onToggleMark={onToggleMark}
            onOpenAmbientSources={onOpenAmbientSources}
            onViewPinDevice={onOpenPinFlow}
          />
        ) : connected ? (
          <ConnectedView
            state={state}
            busy={busy}
            transcripts={transcripts}
            pinCaptureRunning={pinCaptureRunning}
            onStartCapture={onStartCapture}
            onStopCapture={onStopCapture}
            onToggleMark={onToggleMark}
          />
        ) : (
          <ScanView state={state} status={status} busy={busy} onScan={onScan} onConnect={onConnect} />
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      <DeviceDetailsSheet
        visible={deviceDetailsOpen}
        state={state}
        busy={busy}
        onClose={() => setDeviceDetailsOpen(false)}
        onDisconnect={() => {
          setDeviceDetailsOpen(false);
          onDisconnect();
        }}
        onToggleAutoReconnect={onToggleAutoReconnect}
      />
    </View>
  );
}

// ── 子视图 ──────────────────────────────────────────────────────────────

function DeviceStatusBar({
  state,
  status,
  busy,
  activeSource,
  onOpenDetails,
  onOpenPinFlow,
  onScan,
}: {
  state: PinHardwareState | null;
  status: { label: string; description: string; tone: StatusTone };
  busy: BusyAction;
  activeSource: ActiveSource;
  onOpenDetails: () => void;
  onOpenPinFlow: () => void;
  onScan: () => void;
}) {
  const { t } = useTranslation("connect");
  const connected = hasConnectedPinPeripheral(state);
  const ready = state?.connected === true;
  const capturing = ready && state.captureRunning === true;
  const connectionFailed = state?.status === "connect_failed"
    || state?.status === "service_discovery_failed"
    || state?.status === "characteristic_discovery_failed"
    || state?.status === "service_not_found";
  const scanning = !connected && isPinHardwareScanning(state, busy === "scan");
  const connecting = (!ready && connected && !connectionFailed)
    || busy === "connect"
    || state?.status === "connecting"
    || state?.status === "discovering_services";
  const captureStarting = state?.status === "capture_starting"
    || state?.status === "device_capture_requested";
  const reconnecting = state?.status === "connect_retrying";
  const captureStartFailed = state?.status === "capture_start_failed";
  const showSpinner = scanning || connecting || reconnecting || captureStarting;
  const battery = state?.batteryPercent == null ? null : `${state.batteryPercent}%`;
  const firmware = state?.firmwareVersion?.trim() || null;
  const meta = [battery, firmware].filter(Boolean).join(" · ");
  const metaSuffix = meta ? ` · ${meta}` : "";
  const label = capturing
    ? t("pinHardware.deviceStatus.capturing", { meta: metaSuffix })
    : captureStarting
      ? t("pinHardware.status.captureStarting")
      : connecting
      ? t("pinHardware.deviceStatus.connecting")
      : reconnecting
        ? t("pinHardware.deviceStatus.reconnecting")
        : scanning
          ? t("pinHardware.deviceStatus.scanning")
          : captureStartFailed
            ? t("pinHardware.status.captureStartFailed")
            : status.tone === "warn"
              ? status.label
              : connected
                ? t("pinHardware.deviceStatus.connected", { meta: metaSuffix })
              : t("pinHardware.deviceStatus.disconnected");

  return (
    <View style={styles.deviceStatusRow}>
      <Pressable
        onPress={connected ? onOpenDetails : onScan}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={6}
        style={styles.deviceStatusMain}
      >
        {showSpinner ? (
          <Spinner size={12} color={PINK_SOLID} />
        ) : (
          <View style={[styles.deviceStatusDot, !connected && styles.deviceStatusDotMuted]} />
        )}
        <Text style={styles.deviceStatusText} numberOfLines={1}>{label}</Text>
        {connected ? <ChevronRight size={13} color={fg(0.42)} /> : null}
      </Pressable>
      {activeSource === "phone" ? (
        <Pressable
          onPress={onOpenPinFlow}
          accessibilityRole="button"
          hitSlop={6}
          style={styles.deviceReturnButton}
        >
          <Text style={styles.deviceReturnText}>{t("pinHardware.usePinDevice")}</Text>
          <ChevronRight size={12} color={fg(0.45)} />
        </Pressable>
      ) : null}
    </View>
  );
}

function DeviceDetailsSheet({
  visible,
  state,
  busy,
  onClose,
  onDisconnect,
  onToggleAutoReconnect,
}: {
  visible: boolean;
  state: PinHardwareState | null;
  busy: BusyAction;
  onClose: () => void;
  onDisconnect: () => void;
  onToggleAutoReconnect: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("connect");
  const insets = useSafeAreaInsets();
  const battery = state?.batteryPercent == null
    ? t("pinHardware.metrics.batteryUnknown")
    : `${state.batteryPercent}%`;
  const bluetooth = t(`pinHardware.bluetooth.${state?.bluetoothState ?? "unknown"}`, {
    defaultValue: state?.bluetoothState ?? "—",
  });
  const firmware = state?.firmwareVersion ?? t("pinHardware.settings.unreported");

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable onPress={onClose} accessibilityRole="button" style={styles.sheetBackdrop} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHeader}>
            <View style={styles.flex1MinW0}>
              <Text style={styles.sheetTitle}>{t("pinHardware.deviceDetailsTitle")}</Text>
              <Text style={styles.sheetDeviceName} numberOfLines={1}>
                {state?.deviceName ?? t("pinHardware.deviceNameFallback")}
              </Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t("pinHardware.close")} style={styles.sheetClose}>
              <X size={18} color={fg(0.62)} />
            </Pressable>
          </View>

          <View style={styles.sheetMetaRow}>
            <Text style={styles.sheetMetaText}>{t("pinHardware.metrics.battery")} {battery}</Text>
            <View style={styles.sheetMetaDot} />
            <Text style={styles.sheetMetaText}>{t("pinHardware.metrics.bluetooth")} {bluetooth}</Text>
            <View style={styles.sheetMetaDot} />
            <Text style={styles.sheetMetaText}>{t("pinHardware.metrics.firmware")} {firmware}</Text>
          </View>

          <View style={styles.sheetSettingRow}>
            <View style={styles.flex1MinW0}>
              <Text style={styles.settingTitle}>{t("pinHardware.settings.defaultDevice")}</Text>
              <Text style={styles.settingDesc}>{t("pinHardware.settings.defaultDeviceDesc")}</Text>
            </View>
            <Switch
              value={state?.autoReconnect !== false}
              onValueChange={onToggleAutoReconnect}
              disabled={busy !== null}
              trackColor={{ true: PINK_SOLID }}
              accessibilityLabel={t("pinHardware.settings.defaultDevice")}
            />
          </View>

          <Pressable
            onPress={onDisconnect}
            disabled={busy !== null}
            accessibilityRole="button"
            style={[styles.sheetDisconnect, busy !== null && styles.disabled]}
          >
            {busy === "disconnect" ? <Spinner size={15} color="#dc2626" /> : <Unplug size={15} color="#dc2626" />}
            <View style={styles.flex1MinW0}>
              <Text style={styles.sheetDisconnectTitle}>{t("pinHardware.disconnect")}</Text>
              <Text style={styles.settingDesc}>{t("pinHardware.settings.disconnectDesc")}</Text>
            </View>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

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
  const scanning = isPinHardwareScanning(state, busy === "scan");
  const devices = state?.devices ?? [];
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <GlassCard style={styles.scanHero}>
        <View style={styles.scanIconCircle}>
          {scanning ? <Spinner size={24} color={PINK_SOLID} /> : <Bluetooth size={23} color={PINK_SOLID} />}
        </View>
        <Text style={styles.scanTitle}>
          {scanning ? t("pinHardware.scanningEmptyTitle") : t("pinHardware.scanHeroTitle")}
        </Text>
        <Text style={styles.emptyHint}>
          {scanning ? t("pinHardware.scanningEmptyHint") : status.description}
        </Text>
        {!scanning ? (
          <Pressable
            onPress={onScan}
            disabled={busy === "scan"}
            accessibilityRole="button"
            style={[styles.primaryOutlineButton, busy === "scan" && styles.disabled]}
          >
            {busy === "scan" ? <Spinner size={15} color={PINK_TEXT} /> : <RefreshCw size={15} color={PINK_TEXT} />}
            <Text style={styles.primaryOutlineText}>{t("pinHardware.scan")}</Text>
          </Pressable>
        ) : null}
      </GlassCard>

      {devices.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.listLabel}>{t("pinHardware.nearbyDevices")}</Text>
          {devices.map((device, index) => {
            const isConnected = device.connected;
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
      ) : null}
    </ScrollView>
  );
}

function ConnectedView({
  state,
  busy,
  transcripts,
  pinCaptureRunning,
  onStartCapture,
  onStopCapture,
  onToggleMark,
}: {
  state: PinHardwareState | null;
  busy: BusyAction;
  transcripts: TranscriptLine[];
  pinCaptureRunning: boolean;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onToggleMark: (lineId: string) => void;
}) {
  const { t } = useTranslation("connect");
  const ready = state?.connected === true;
  const connectionFailed = state?.status === "connect_failed"
    || state?.status === "service_discovery_failed"
    || state?.status === "characteristic_discovery_failed"
    || state?.status === "service_not_found";
  const phase = transcriptionPhase(t, state, transcripts.length);
  const elapsed = useCaptureElapsed(pinCaptureRunning);
  const captureStarting = !pinCaptureRunning && (
    busy === "capture"
    || state?.status === "capture_starting"
    || state?.status === "device_capture_requested"
    || state?.asrState === "connecting"
  );
  return (
    <View style={styles.connectedView}>
      <PinTranscriptPanel
        state={state}
        transcripts={transcripts}
        running={pinCaptureRunning}
        elapsed={elapsed}
        phase={phase}
        onToggleMark={onToggleMark}
      />
      <Pressable
        onPress={pinCaptureRunning ? onStopCapture : onStartCapture}
        disabled={!ready || busy !== null || captureStarting}
        accessibilityRole="button"
        style={[styles.captureButton, (!ready || busy !== null || captureStarting) && styles.disabled]}
      >
        {(!ready && !connectionFailed) || busy === "stop" || captureStarting ? (
          <Spinner size={15} color="#fff" />
        ) : pinCaptureRunning ? (
          <Square size={15} color="#fff" fill="#fff" />
        ) : (
          <Play size={15} color="#fff" fill="#fff" />
        )}
        <Text style={styles.captureButtonText}>
          {!ready
            ? connectionFailed
              ? t("pinHardware.status.connectFailed")
              : t("pinHardware.status.connecting")
            : captureStarting
            ? t("pinHardware.status.captureStarting")
            : pinCaptureRunning
              ? t("pinHardware.stopCapture")
              : t("pinHardware.startCapture")}
        </Text>
      </Pressable>
    </View>
  );
}

function useCaptureElapsed(running: boolean): string {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);
  return formatDuration(elapsedSeconds);
}

function PinTranscriptPanel({
  state,
  transcripts,
  running,
  elapsed,
  phase,
  onToggleMark,
}: {
  state: PinHardwareState | null;
  transcripts: TranscriptLine[];
  running: boolean;
  elapsed: string;
  phase: { label: string; emptyLabel: string; tone: StatusTone };
  onToggleMark: (lineId: string) => void;
}) {
  const { t } = useTranslation("connect");
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<ScrollView | null>(null);
  const stickToBottomRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const previousLatestLineIdRef = useRef<string | null>(null);
  const pendingAutoScrollRef = useRef<"animated" | "immediate" | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [scrollMetrics, setScrollMetrics] = useState({
    contentHeight: 0,
    viewportHeight: 0,
    offsetY: 0,
  });
  const latestLine = transcripts[transcripts.length - 1];
  const phaseNeedsAttention = phase.tone === "warn" || state?.asrState === "connecting";
  const headerLabel = running
    ? phaseNeedsAttention
      ? phase.label
      : t("pinHardware.recordingNow")
    : t("pinHardware.standby");

  useLayoutEffect(() => {
    if (!latestLine) {
      previousLatestLineIdRef.current = null;
      pendingAutoScrollRef.current = null;
      return;
    }
    const previousLatestLineId = previousLatestLineIdRef.current;
    const isNewLine = previousLatestLineId != null && previousLatestLineId !== latestLine.id;
    previousLatestLineIdRef.current = latestLine.id;
    pendingAutoScrollRef.current = isNewLine && !reduceMotion ? "animated" : "immediate";
  }, [latestLine?.id, reduceMotion, transcripts]);

  const scrollToLatest = useCallback((animated: boolean) => {
    autoScrollingRef.current = animated;
    scrollRef.current?.scrollToEnd({ animated });
    if (!animated) autoScrollingRef.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollToLatest(!reduceMotion);
  }, [reduceMotion, scrollToLatest]);

  const scrollableHeight = Math.max(
    scrollMetrics.contentHeight - scrollMetrics.viewportHeight,
    0,
  );
  const scrollTrackHeight = Math.max(scrollMetrics.viewportHeight - 16, 0);
  const scrollThumbHeight = scrollableHeight > 0
    ? Math.max(
      36,
      scrollTrackHeight * (scrollMetrics.viewportHeight / scrollMetrics.contentHeight),
    )
    : 0;
  const scrollThumbOffset = scrollableHeight > 0
    ? Math.min(Math.max(scrollMetrics.offsetY / scrollableHeight, 0), 1)
      * Math.max(scrollTrackHeight - scrollThumbHeight, 0)
    : 0;

  return (
    <GlassCard style={styles.transcriptCanvas}>
      <View style={styles.transcriptCanvasHeader}>
        <View style={styles.transcriptStatusGroup}>
          <View style={[
            styles.transcriptLiveDot,
            phase.tone === "warn" && styles.transcriptLiveDotWarn,
            !running && styles.transcriptLiveDotMuted,
          ]} />
          <Text style={styles.transcriptStatusText} numberOfLines={1}>
            {headerLabel}{running ? ` ${elapsed}` : ""}
          </Text>
        </View>
        {latestLine ? (
          <Pressable
            onPress={() => onToggleMark(latestLine.id)}
            accessibilityRole="button"
            accessibilityLabel={t("pinHardware.markImportant")}
            accessibilityState={{ selected: latestLine.marked === true }}
            hitSlop={10}
            style={styles.transcriptBookmarkButton}
          >
            <Bookmark
              size={20}
              color={latestLine.marked ? PINK_SOLID : fg(0.58)}
              fill={latestLine.marked ? PINK_SOLID : "transparent"}
            />
          </Pressable>
        ) : null}
      </View>

      {transcripts.length === 0 ? (
        <View style={styles.transcriptCanvasEmpty}>
          <View style={styles.emptyIconCircle}>
            <Mic size={20} color={PINK_SOLID} />
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.emptyHint}>
            {running ? phase.emptyLabel : t("pinHardware.emptyTranscript")}
          </Text>
        </View>
      ) : (
        <View style={styles.transcriptScrollArea}>
          <ScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            onLayout={(event) => {
              const viewportHeight = event.nativeEvent.layout.height;
              setScrollMetrics((previous) => previous.viewportHeight === viewportHeight
                ? previous
                : { ...previous, viewportHeight });
            }}
            onContentSizeChange={(_width, contentHeight) => {
              setScrollMetrics((previous) => previous.contentHeight === contentHeight
                ? previous
                : { ...previous, contentHeight });
              if (!stickToBottomRef.current) {
                pendingAutoScrollRef.current = null;
                return;
              }
              const mode = pendingAutoScrollRef.current;
              if (!mode) return;
              pendingAutoScrollRef.current = null;
              scrollToLatest(mode === "animated");
            }}
            onScrollBeginDrag={() => {
              autoScrollingRef.current = false;
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              setScrollMetrics({
                contentHeight: contentSize.height,
                viewportHeight: layoutMeasurement.height,
                offsetY: contentOffset.y,
              });
              const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
              if (autoScrollingRef.current) {
                if (distanceFromBottom < 4) {
                  autoScrollingRef.current = false;
                  stickToBottomRef.current = true;
                  setShowJumpToLatest(false);
                }
                return;
              }
              const awayFromBottom = distanceFromBottom >= 48;
              stickToBottomRef.current = !awayFromBottom;
              setShowJumpToLatest(awayFromBottom);
            }}
            scrollEventThrottle={32}
            style={styles.flex1}
            contentContainerStyle={styles.transcriptListContent}
          >
            {transcripts.map((line, index) => {
              return (
                <PinTranscriptLine
                  key={line.id}
                  line={line}
                  newest={index === transcripts.length - 1}
                  showDivider={index < transcripts.length - 1}
                  deviceName={state?.deviceName}
                  reduceMotion={reduceMotion}
                  t={t}
                />
              );
            })}
          </ScrollView>
          {scrollableHeight > 0 ? (
            <View pointerEvents="none" style={styles.transcriptScrollTrack}>
              <View
                style={[
                  styles.transcriptScrollThumb,
                  {
                    height: scrollThumbHeight,
                    transform: [{ translateY: scrollThumbOffset }],
                  },
                ]}
              />
            </View>
          ) : null}
        </View>
      )}

      {showJumpToLatest ? (
        <Animated.View
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(100)}
          style={styles.jumpToLatestButton}
        >
          <Pressable
            onPress={jumpToLatest}
            accessibilityRole="button"
            style={styles.jumpToLatestPressable}
          >
            <Text style={styles.jumpToLatestText}>{t("pinHardware.jumpToLatest")}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </GlassCard>
  );
}

const PinTranscriptLine = memo(function PinTranscriptLine({
  line,
  newest,
  showDivider,
  deviceName,
  reduceMotion,
  t,
}: {
  line: TranscriptLine;
  newest: boolean;
  showDivider: boolean;
  deviceName?: string;
  reduceMotion: boolean;
  t: TFunction<"connect">;
}) {
  const lineEntering = reduceMotion
    ? FadeIn.duration(120)
    : FadeInDown.duration(220).easing(Easing.bezier(0.16, 1, 0.3, 1));

  return (
    <Animated.View
      entering={lineEntering}
      style={[styles.transcriptLine, showDivider && styles.transcriptLineBorder]}
    >
      <View style={styles.transcriptLineMeta}>
        <Text style={styles.transcriptLineTime}>{formatTime(line.capturedAt)}</Text>
        <Animated.Text
          key={`${line.id}:${line.speaker}`}
          entering={FadeIn.duration(140)}
          exiting={FadeOut.duration(90)}
          style={styles.transcriptLineSpeaker}
        >
          {displaySpeaker(t, line.speaker, deviceName)}
        </Animated.Text>
      </View>
      <Text style={[
        styles.transcriptLineText,
        newest && styles.transcriptLineTextNewest,
        line.pending && styles.transcriptLineTextPending,
      ]}>
        {line.text}{line.pending ? " …" : ""}
      </Text>
    </Animated.View>
  );
});

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
  // 三种收录状态,横幅/空态各自表达:手机在录(活跃横幅)、PIN 设备在录
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
        statusLabel={phoneSourceReady ? undefined : t("pinHardware.off")}
        statusTone={phoneSourceReady ? "active" : "muted"}
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
  statusLabel,
  statusTone = "active",
}: {
  transcripts: TranscriptLine[];
  emptyLabel: string;
  emptyAction?: ReactNode;
  onToggleMark: (lineId: string) => void;
  anchor: "top" | "bottom";
  fill?: boolean;
  maxHeight?: number;
  statusLabel?: string;
  statusTone?: StatusTone;
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
        <StatusPill label={statusLabel ?? t("pinHardware.live")} tone={statusTone} />
      </View>
      {transcripts.length === 0 ? (
        <View style={styles.panelEmpty}>
          <View style={styles.emptyIconCircle}>
            <Mic size={18} color={PINK_SOLID} />
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.emptyHint}>{emptyLabel}</Text>
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

function CaptureBanner({ label, icon }: { label: string; icon: ReactNode }) {
  return (
    <View style={styles.banner}>
      <View style={styles.bannerDot} />
      <Text style={styles.bannerText} numberOfLines={1}>{label}</Text>
      {icon}
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
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.58)",
    backgroundColor: "rgba(255,255,255,0.28)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 22,
    lineHeight: 27,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: tracking(22, EM_TIGHT),
    color: "#1d2130",
  },

  deviceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
    marginHorizontal: 22,
    marginTop: 2,
    marginBottom: 6,
    gap: 10,
  },
  deviceStatusMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: 32,
  },
  deviceStatusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#34c759" },
  deviceStatusDotMuted: { backgroundColor: fg(0.24) },
  deviceStatusText: {
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: "Inter_500Medium",
    color: fg(0.7),
  },
  deviceReturnButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 32,
  },
  deviceReturnText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_500Medium", color: fg(0.48) },

  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(17,19,28,0.28)",
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: "rgba(251,249,252,0.98)",
    paddingHorizontal: 20,
    paddingTop: 18,
    boxShadow: "0 -12px 36px rgba(17,19,28,0.12)",
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  sheetTitle: { fontSize: 19, lineHeight: 25, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  sheetDeviceName: { marginTop: 2, fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.45) },
  sheetClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: fg(0.05),
    alignItems: "center",
    justifyContent: "center",
  },
  sheetMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 18,
    borderRadius: 14,
    backgroundColor: fg(0.035),
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sheetMetaText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_500Medium", color: fg(0.56) },
  sheetMetaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: fg(0.24) },
  sheetSettingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: fg(0.08),
  },
  sheetDisconnect: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
  },
  sheetDisconnectTitle: { fontSize: 13, lineHeight: 18, fontFamily: "Inter_600SemiBold", color: "#dc2626" },

  content: { flex: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 4 },
  scrollContent: { gap: 12, paddingBottom: 16 },
  phoneView: { flex: 1, minHeight: 0, gap: 12 },
  scanHero: {
    minHeight: 220,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 28,
  },
  scanIconCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: pink(0.1),
    alignItems: "center",
    justifyContent: "center",
  },
  scanTitle: { fontSize: 17, lineHeight: 23, fontFamily: "Inter_600SemiBold", color: fg(0.82) },

  primaryOutlineButton: {
    marginTop: 4,
    minHeight: 44,
    minWidth: 148,
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

  emptyIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: pink(0.1),
    alignItems: "center",
    justifyContent: "center",
  },
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
  settingTitle: { fontSize: 13, lineHeight: 17, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  settingDesc: { marginTop: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.45) },

  connectedView: { flex: 1, minHeight: 0, gap: 12 },
  captureButton: {
    minHeight: 50,
    borderRadius: 16,
    backgroundColor: PINK_SOLID,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    boxShadow: "0 7px 18px rgba(199,31,187,0.12)",
  },
  captureButtonText: { fontSize: 15, lineHeight: 22, fontFamily: "Inter_500Medium", color: "#fff" },
  transcriptCanvas: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  transcriptCanvasHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 34,
    marginBottom: 3,
  },
  transcriptStatusGroup: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  transcriptLiveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: PINK_SOLID },
  transcriptLiveDotWarn: { backgroundColor: "#f59e0b" },
  transcriptLiveDotMuted: { backgroundColor: fg(0.25) },
  transcriptStatusText: { fontSize: 14, lineHeight: 19, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },
  transcriptBookmarkButton: { padding: 7, marginRight: -7 },
  transcriptCanvasEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingBottom: 38 },
  transcriptScrollArea: { flex: 1, minHeight: 0, marginRight: -6 },
  transcriptListContent: { paddingRight: 14, paddingBottom: 64 },
  transcriptScrollTrack: {
    position: "absolute",
    top: 8,
    right: 2,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: pink(0.1),
  },
  transcriptScrollThumb: {
    width: 3,
    borderRadius: 2,
    backgroundColor: PINK_SOLID,
  },
  transcriptLine: { paddingVertical: 14 },
  transcriptLineBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: fg(0.09) },
  transcriptLineMeta: { flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 7 },
  transcriptLineTime: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.43) },
  transcriptLineSpeaker: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },
  transcriptLineText: { fontSize: 15, lineHeight: 23, fontFamily: "Inter_400Regular", color: fg(0.83) },
  transcriptLineTextNewest: { fontFamily: "Inter_500Medium", color: fg(0.92) },
  transcriptLineTextPending: { color: fg(0.56), fontFamily: "Inter_400Regular" },
  jumpToLatestButton: {
    position: "absolute",
    right: 18,
    bottom: 16,
    minHeight: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderWidth: 1,
    borderColor: pink(0.2),
    boxShadow: "0 4px 12px rgba(17,19,28,0.08)",
  },
  jumpToLatestPressable: {
    minHeight: 34,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  jumpToLatestText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_600SemiBold", color: PINK_TEXT },

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

  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 160 },
  pillText: { fontSize: 10, lineHeight: 13, fontFamily: "Inter_600SemiBold" },
});
