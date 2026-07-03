/**
 * VoiceIdentitySettings — web account/VoiceIdentitySettings 的 RN 对应物
 * （settings → Ambient 子页第②块）。录一段 2–10s 自我参考音 → 上传作声纹基准，
 * Ambient 转写时把"自己说的话"标成 self（diarization）。
 *
 * 平台适配（非阉割）：
 *  - 读类 API（fetch / enable / delete）用 @pin-ai/core 共享版（proxyFetch，双端同源）。
 *  - 录音用 expo-audio（按需录 + 回放）；web 是 WebAudio PcmRecorder，RN 介质等价。
 *  - 上传走 expo-file-system file.upload（RN 验证过的二进制上传路径，同 sound-classifier），
 *    不用 core 的 Blob+proxyFetch（RN 的 fetch Blob body 不可靠）——同一端点、平台适配上传介质。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  type AudioPlayer,
} from "expo-audio";
import { File, UploadType } from "expo-file-system";
import { CircleEllipsis, Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import {
  acquireExternalMic,
  deleteVoiceIdentityReference,
  fetchVoiceIdentity,
  getTransportConfig,
  setVoiceIdentityEnabled,
  type ExternalMicLease,
  type VoiceIdentityProfile,
} from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import i18n from "../../i18n";
import { WAV_CONTENT_TYPE, WAV_RECORDING_OPTIONS } from "../../voice/recording";
import { GlassCard } from "../../ui/GlassCard";
import { AirplayRouteButton } from "../../../modules/airplay-route";

const TARGET_DURATION_MS = 5_000;
const MIN_DURATION_MS = 2_000;
const MAX_DURATION_MS = 10_000;
const ENGLISH_PROMPT =
  "This morning I checked my schedule, and this afternoon I will reply to a colleague.";
const CHINESE_PROMPT = "今天早上我整理了日程，下午会给同事回一条消息。";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "220, 30%, 96%";
const bg = (a?: number) => (a === undefined ? `hsl(${BG})` : `hsla(${BG}, ${a})`);
const DESTRUCTIVE = "hsl(0, 72%, 60%)";
const DESTRUCTIVE_BG = "hsla(0, 72%, 60%, 0.1)";

function formatDuration(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function formatDate(value: string | null): string {
  if (!value) return i18n.t("account:voiceIdentity.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("account:voiceIdentity.unknown");
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptFor(language: string | null | undefined): string {
  return language?.toLowerCase().startsWith("zh") ? CHINESE_PROMPT : ENGLISH_PROMPT;
}

/** RN 上传参考音：expo-file-system file.upload（二进制 + 401 刷新重试），对齐 sound-classifier。 */
async function uploadVoiceReference(
  uri: string,
  durationMs: number,
): Promise<VoiceIdentityProfile | null> {
  const cfg = getTransportConfig();
  const file = new File(uri);
  const baseHeaders = {
    ...(cfg.defaultHeaders ?? {}),
    // 后端 wave.open 校验：必须是 WAV（录音档位见 voice/recording.ts），对齐 dev
    // uploadVoiceIdentityReference 的 Content-Type audio/wav。
    "Content-Type": WAV_CONTENT_TYPE,
    "X-Audio-Duration-Ms": String(Math.round(durationMs)),
  };
  const url = `${cfg.baseUrl}/api/voice/identity/reference`;
  const upload = (headers: Record<string, string>) =>
    file.upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers,
      mimeType: WAV_CONTENT_TYPE,
      sessionType: "foreground",
    });

  let result = await upload({ ...baseHeaders, ...(await cfg.getAuthHeaders()) });
  if (result.status === 401 && cfg.refreshAuth) {
    const token = await cfg.refreshAuth();
    if (token) result = await upload({ ...baseHeaders, Authorization: `Bearer ${token}` });
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`/voice/identity/reference failed: ${result.status} ${result.body}`);
  }
  const data = JSON.parse(result.body) as { profile?: VoiceIdentityProfile | null };
  return data.profile ?? null;
}

// ── 小钮（Pressable 只管 onPress，样式全内层 View）──
function PillButton({
  Icon,
  label,
  onPress,
  disabled,
  tone = "solid",
}: {
  Icon?: typeof Mic;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "solid" | "soft" | "danger";
}) {
  const palette =
    tone === "solid"
      ? { bg: fg(), fg: bg() }
      : tone === "danger"
        ? { bg: DESTRUCTIVE_BG, fg: DESTRUCTIVE }
        : { bg: fg(0.08), fg: fg(0.7) };
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <View
        style={{
          minHeight: 40,
          borderRadius: 20,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          backgroundColor: palette.bg,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {Icon ? <Icon size={14} strokeWidth={2} color={palette.fg} /> : null}
        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: palette.fg }}>{label}</Text>
      </View>
    </Pressable>
  );
}

// 录音复听播放器——dev 用浏览器原生 <audio controls>(iOS WebView 渲染成 Apple 播放器);
// RN 无等价原生组件(Apple 也没公开可复用的内联音频 view,原生 App 同样手搭),这里自建:
// 灰条 + 播放/暂停 + 可拖进度条 + 当前/剩余时间 + Airplay/"..." 图标。播放/拖动/时间全真实
// (expo-audio);Airplay/"..." 先为视觉图标(真路由需 AVRoutePickerView 原生 view,另议)。
const PLAYER_BG = "rgba(100,100,110,0.88)"; // iOS systemGray 风格中灰条(0.5→0.88 加深,叠浅卡后≈中灰;按真机微调)
const PLAYER_FG = "rgba(255,255,255,0.95)"; // 白色播放键/时间
const PLAYER_TRACK = "rgba(255,255,255,0.3)"; // 未填充轨道
const CLOCK = { fontFamily: "Inter_500Medium" as const, fontVariant: ["tabular-nums" as const] };

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function ReviewPlayer({ player }: { player: AudioPlayer }) {
  const status = useAudioPlayerStatus(player);
  const duration = status.duration > 0 ? status.duration : 0;
  const [trackW, setTrackW] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null); // 拖动中的 ratio(0..1),否则 null
  const [rate, setRate] = useState(1); // 播放速度(× 倍):UIMenu 勾选 + player.setPlaybackRate
  const playing = status.playing;
  const ratio = scrub ?? (duration > 0 ? clamp01(status.currentTime / duration) : 0);
  const shownCurrent = scrub != null ? scrub * duration : status.currentTime;

  const toggle = useCallback(() => {
    if (playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (duration > 0 && status.currentTime >= duration - 0.05)) player.seekTo(0);
    player.play();
  }, [playing, status.didJustFinish, status.currentTime, duration, player]);

  const seekToRatio = useCallback(
    (r: number) => {
      player.seekTo(clamp01(r) * duration);
      setScrub(null);
    },
    [player, duration],
  );

  const gesture = useMemo(() => {
    const tap = Gesture.Tap().onEnd((e) => {
      if (trackW > 0) runOnJS(seekToRatio)(e.x / trackW);
    });
    const pan = Gesture.Pan()
      .activeOffsetX([-6, 6])
      .onUpdate((e) => {
        if (trackW > 0) runOnJS(setScrub)(clamp01(e.x / trackW));
      })
      .onEnd((e) => {
        if (trackW > 0) runOnJS(seekToRatio)(e.x / trackW);
      });
    return Gesture.Race(pan, tap);
  }, [trackW, seekToRatio]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 38,
        borderRadius: 14,
        backgroundColor: PLAYER_BG,
        paddingHorizontal: 12,
      }}
    >
      <Pressable onPress={toggle} hitSlop={8} accessibilityRole="button" accessibilityLabel={playing ? "Pause" : "Play"}>
        {playing ? (
          <Pause size={20} color={PLAYER_FG} fill={PLAYER_FG} />
        ) : (
          <Play size={20} color={PLAYER_FG} fill={PLAYER_FG} />
        )}
      </Pressable>
      <Text style={{ ...CLOCK, fontSize: 12, color: PLAYER_FG }}>{fmtClock(shownCurrent)}</Text>
      <GestureDetector gesture={gesture}>
        <View style={{ flex: 1, height: 28, justifyContent: "center" }} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: PLAYER_TRACK }}>
            <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: ratio * trackW, backgroundColor: PLAYER_FG, borderRadius: 2 }} />
          </View>
          <View
            style={{
              position: "absolute",
              left: Math.max(0, ratio * trackW - 7),
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
            }}
          />
        </View>
      </GestureDetector>
      <Text style={{ ...CLOCK, fontSize: 12, color: PLAYER_FG }}>-{fmtClock(duration - shownCurrent)}</Text>
      {/* 投屏 = 真原生 AVRoutePickerView(系统 AirPlay 路由选择器,dev 同款系统控件);
          点击弹出的路由 sheet 位置由 iOS 托管(底部升起),无法锚定,和 dev 一致。 */}
      <AirplayRouteButton style={{ width: 24, height: 24 }} />
      {/* "..." → 真 iOS UIMenu(标题 + 勾选),接 expo-audio setPlaybackRate。UIMenu 系统锚定按钮弹出。 */}
      <MenuView
        title="Playback Speed"
        shouldOpenOnLongPress={false}
        onPressAction={({ nativeEvent }) => {
          const sp = Number(nativeEvent.event);
          if (!Number.isNaN(sp)) {
            setRate(sp);
            player.setPlaybackRate(sp);
          }
        }}
        actions={[0.5, 1, 1.25, 1.5, 2].map((sp) => ({
          id: String(sp),
          title: `${sp}×`,
          state: (sp === rate ? "on" : "off") as "on" | "off",
        }))}
      >
        <CircleEllipsis size={18} color={PLAYER_FG} strokeWidth={1.8} />
      </MenuView>
    </View>
  );
}

export default function VoiceIdentitySettings({ userId }: { userId: string | null }) {
  const { t } = useTranslation("account");
  const { settings } = useUserSettings(userId);
  const [profile, setProfile] = useState<VoiceIdentityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reviewUri, setReviewUri] = useState<string | null>(null);
  const [reviewDurationMs, setReviewDurationMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorder = useAudioRecorder(WAV_RECORDING_OPTIONS);
  const player = useAudioPlayer(reviewUri ?? undefined);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaseRef = useRef<ExternalMicLease | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetchVoiceIdentity()
      .then((next) => mounted && setProfile(next))
      .catch((err) => mounted && setError(errorMessage(err)))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    tickRef.current = null;
    autoStopRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearTimers();
      void leaseRef.current?.release();
      leaseRef.current = null;
    },
    [clearTimers],
  );

  const stopRecording = useCallback(async () => {
    clearTimers();
    setRecording(false);
    const durationMs = Math.min(Date.now() - startedAtRef.current, MAX_DURATION_MS);
    setElapsedMs(durationMs);
    try {
      await recorder.stop();
      setReviewUri(recorder.uri ?? null);
      setReviewDurationMs(durationMs);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // recorder released the mic — hand the native ambient mic back now,
      // independent of upload, so it isn't left suppressed (mirrors web).
      await leaseRef.current?.release();
      leaseRef.current = null;
    }
  }, [clearTimers, recorder]);

  const startRecording = useCallback(async () => {
    setError(null);
    setReviewUri(null);
    setReviewDurationMs(0);
    try {
      // Yield the native ambient mic before grabbing the recorder so the two
      // don't fight over the shared iOS audio session (mirrors web; the RN
      // acquirer is registered in App.tsx → AmbientAudio.setExternalMicSuppressed).
      leaseRef.current = await acquireExternalMic();
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError("Microphone permission denied.");
        await leaseRef.current?.release();
        leaseRef.current = null;
        return;
      }
      // If ambient was running, the suppress above tears down its AVAudioEngine +
      // deactivates the shared iOS session asynchronously on the audio queue; a
      // prepare can race that handoff and throw "Failed to prepare recorder".
      // Retry with backoff, re-asserting the recording session before each attempt
      // (~2s worst case) so the recorder grabs a freed, active session.
      let prepared = false;
      let lastPrepErr: unknown = null;
      for (const wait of [0, 250, 600, 1200]) {
        if (wait) await delay(wait);
        try {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorder.prepareToRecordAsync();
          prepared = true;
          break;
        } catch (prepErr) {
          lastPrepErr = prepErr;
        }
      }
      if (!prepared) throw lastPrepErr ?? new Error("recorder failed to prepare");
      recorder.record();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      tickRef.current = setInterval(() => {
        setElapsedMs(Math.min(Date.now() - startedAtRef.current, MAX_DURATION_MS));
      }, 200);
      autoStopRef.current = setTimeout(() => void stopRecording(), MAX_DURATION_MS);
    } catch (err) {
      await leaseRef.current?.release();
      leaseRef.current = null;
      setError(errorMessage(err));
    }
  }, [recorder, stopRecording]);

  const saveReview = useCallback(async () => {
    if (!reviewUri || reviewDurationMs < MIN_DURATION_MS) {
      setError(i18n.t("account:voiceIdentity.tooShort"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await uploadVoiceReference(reviewUri, reviewDurationMs);
      setProfile(next);
      setReviewUri(null);
      setReviewDurationMs(0);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [reviewUri, reviewDurationMs]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setProfile(await setVoiceIdentityEnabled(enabled));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteReference = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteVoiceIdentityReference();
      setProfile(null);
      setReviewUri(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const reviewTooShort = Boolean(reviewUri) && reviewDurationMs < MIN_DURATION_MS;
  const enrolled = profile !== null;
  const status = loading
    ? t("voiceIdentity.statusLoading")
    : !enrolled
      ? t("voiceIdentity.statusNotEnrolled")
      : profile.enabled
        ? t("voiceIdentity.statusEnrolled")
        : t("voiceIdentity.statusDisabled");

  return (
    <GlassCard strong className="mt-3 p-4">
      {/* 头：标题 + 描述 + 状态徽 */}
      {/* 标题 + 状态徽 同一行 */}
      <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 18, color: fg() }}>
          {t("voiceIdentity.title")}
        </Text>
        <View style={{ borderRadius: 999, backgroundColor: fg(0.06), paddingHorizontal: 10, paddingVertical: 4 }}>
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 13, color: fg(0.55) }}>{status}</Text>
        </View>
      </View>
      {/* 副标题独占整行 → 拿到全卡宽,一行容纳(按用户要求,不跟 dev 的 2 行)。
          numberOfLines=1 + adjustsFontSizeToFit:正常 11px 一行放得下;真放不下才微缩,绝不换行/截断。 */}
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.45), marginTop: 4 }}
      >
        {t("voiceIdentity.description")}
      </Text>

      {/* Read aloud 提示 */}
      <View style={{ marginTop: 12, borderLeftWidth: 2, borderLeftColor: fg(0.15), paddingLeft: 12 }}>
        <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 13, color: fg(0.35) }}>{t("voiceIdentity.readAloud")}</Text>
        <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 18, color: fg(0.75), marginTop: 4 }}>
          {promptFor(settings?.generationLanguage)}
        </Text>
      </View>

      {/* profile 信息 */}
      {profile ? (
        <View className="flex-row" style={{ gap: 8, marginTop: 12 }}>
          {[
            { label: t("voiceIdentity.duration"), value: formatDuration(profile.referenceDurationMs ?? 0) },
            { label: t("voiceIdentity.updated"), value: formatDate(profile.updatedAt) },
          ].map((row) => (
            <View key={row.label} className="flex-1">
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 14, color: fg(0.35) }}>{row.label}</Text>
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg(0.75), marginTop: 2 }}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* recording */}
      {recording ? (
        <View
          style={{
            marginTop: 12,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: fg(0.1),
            backgroundColor: fg(0.03),
            paddingHorizontal: 12,
            paddingVertical: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View className="flex-1">
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 16, color: fg() }}>
              {t("voiceIdentity.recording", { duration: formatDuration(elapsedMs) })}
            </Text>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 14, color: fg(0.45), marginTop: 2 }}>
              {t("voiceIdentity.recordingTarget", { target: formatDuration(TARGET_DURATION_MS), max: formatDuration(MAX_DURATION_MS) })}
            </Text>
          </View>
          <PillButton Icon={Square} label={t("voiceIdentity.stop")} onPress={() => void stopRecording()} />
        </View>
      ) : null}

      {/* review */}
      {reviewUri && !recording ? (
        <View
          style={{
            marginTop: 12,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: fg(0.1),
            backgroundColor: fg(0.03),
            paddingHorizontal: 12,
            paddingVertical: 12,
            gap: 10,
          }}
        >
          <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 16, color: fg() }}>
              {t("voiceIdentity.review", { duration: formatDuration(reviewDurationMs) })}
            </Text>
            <PillButton Icon={RotateCcw} label={t("voiceIdentity.reRecord")} tone="soft" onPress={() => void startRecording()} />
          </View>
          <ReviewPlayer player={player} />
          {reviewTooShort ? (
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: DESTRUCTIVE }}>
              {t("voiceIdentity.tooShort")}
            </Text>
          ) : null}
          <Pressable onPress={() => void saveReview()} disabled={busy || reviewTooShort} accessibilityRole="button" accessibilityLabel={t("voiceIdentity.saveReference")}>
            <View style={{ minHeight: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: fg(), opacity: busy || reviewTooShort ? 0.4 : 1 }}>
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: bg() }}>{t("voiceIdentity.saveReference")}</Text>
            </View>
          </Pressable>
        </View>
      ) : null}

      {/* 动作钮 */}
      {!recording && !reviewUri ? (
        <View className="flex-row" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <PillButton
            Icon={Mic}
            label={profile ? t("voiceIdentity.reRecord") : t("voiceIdentity.recordSelfReference")}
            onPress={() => void startRecording()}
            disabled={busy || loading}
          />
          {profile && !profile.enabled ? (
            <PillButton label={t("voiceIdentity.enable")} tone="soft" onPress={() => void toggleEnabled(true)} disabled={busy} />
          ) : null}
          {profile && profile.enabled ? (
            <PillButton label={t("voiceIdentity.disable")} tone="soft" onPress={() => void toggleEnabled(false)} disabled={busy} />
          ) : null}
          {profile ? (
            <PillButton Icon={Trash2} label={t("voiceIdentity.delete")} tone="danger" onPress={() => void deleteReference()} disabled={busy} />
          ) : null}
        </View>
      ) : null}

      {error ? (
        <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: DESTRUCTIVE, marginTop: 8 }}>{error}</Text>
      ) : null}
    </GlassCard>
  );
}
