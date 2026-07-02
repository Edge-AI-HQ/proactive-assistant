/**
 * AmbientModelsPanel — web components/ambient/AmbientModelsPanel 的 RN 对应物
 * （settings → Ambient 子页第④块）。端侧模型管理：whisper.cpp ASR + llama.cpp LLM
 * 的 列表 / 下载(带镜像) / 取消 / 删除 / 校验。native 走 ambient-models Expo 模块
 * （从 Capacitor 插件移植）。模型选中态 + mirror 偏好存 AsyncStorage（models-selection）。
 *
 * web 的 <select> 下拉 → RN 改可点模型行（选中高亮，2-3 个模型更清晰）；mirror → 两枚 chip。
 * native 模块未链入(未 rebuild)时调用会抛错并被 catch 显示，不崩。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronsUpDown, Cpu, Loader2, Trash2, XCircle } from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import {
  AmbientModels,
  type ModelDownloadProgressEvent,
  type ModelDownloadStatus,
  type ModelKind,
  type ModelMirror,
  type ModelProfile,
} from "../../../modules/ambient-models";
import {
  clearSelectedAmbientAsrModelId,
  clearSelectedAmbientSummaryModelId,
  getPreferredMirror,
  getSelectedAmbientAsrModelId,
  getSelectedAmbientSummaryModelId,
  setPreferredMirror,
  setSelectedAmbientAsrModelId,
  setSelectedAmbientSummaryModelId,
} from "../../ambient/models-selection";

import { GlassCard } from "../../ui/GlassCard";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "220, 30%, 96%";
const bg = (a?: number) => (a === undefined ? `hsl(${BG})` : `hsla(${BG}, ${a})`);
const DESTRUCTIVE = "hsl(0, 72%, 60%)";
const EMERALD = "#047857";
const MONO = { fontVariant: ["tabular-nums" as const] };

type StatusById = Record<string, ModelDownloadStatus>;

const MIRROR_OPTIONS: { value: ModelMirror; label: string }[] = [
  { value: "hf-mirror", label: "hf-mirror.com (CN)" },
  { value: "hf", label: "huggingface.co" },
];

const KIND_LABEL: Record<ModelKind, string> = {
  asr: "ASR · whisper.cpp",
  llm: "LLM · llama.cpp",
};

const PERSISTERS: Record<
  ModelKind,
  { read: () => Promise<string | null>; write: (id: string) => Promise<void>; clear: () => Promise<void> }
> = {
  asr: {
    read: getSelectedAmbientAsrModelId,
    write: setSelectedAmbientAsrModelId,
    clear: clearSelectedAmbientAsrModelId,
  },
  llm: {
    read: getSelectedAmbientSummaryModelId,
    write: setSelectedAmbientSummaryModelId,
    clear: clearSelectedAmbientSummaryModelId,
  },
};

function formatBytes(value: number): string {
  if (!value || value <= 0) return "—";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPercent(written: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((written / total) * 100));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 旋转 Loader（lucide 不吃 transform → 包 Animated.View 旋转）。 */
function Spinner({ size = 10, color = fg(0.7) }: { size?: number; color?: string }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value * 360}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={size} strokeWidth={2} color={color} />
    </Animated.View>
  );
}

/**
 * 下拉选择框 —— dev `<select>` 的 RN 等价物。dev 是 Capacitor WKWebView，iOS 把
 * `<select>` **自动**渲染成系统原生下拉菜单(深色 UIMenu + 选中打勾 + 系统弹出/滚动
 * 动效)——dev 没写代码，是 OS 给的。RN 用 `@react-native-menu/menu` 的 `MenuView`
 * 拿到**同一个系统 UIMenu**(和语音播放器的速度菜单同款，见 VoiceIdentitySettings)，
 * 而不是自绘浅色菜单。`state:"on"` = 那个勾选；深色外观 / 动效 / 锚定全由系统托管，
 * 无需 zIndex / backdrop。关闭态触发盒对齐 dev select：rounded-md(18) · border
 * foreground/10 · bg white/60 · text-caption(11)/foreground-70 + 双向 chevron。
 */
function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  fullWidth = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  // compact = mirror（内容宽）；fullWidth = 模型选择（对齐 dev w-full <select>：左值右箭头、铺满一行）。
  // 注：收菜单时整个触发框「折叠」一下是 iOS 系统 UIMenu 的收起动效（锚点随菜单缩回），任何用 UIMenu
  // 的库（@react-native-menu/menu / zeego / react-native-ios-context-menu）都有、非布局能治——已与用户
  // 确认「保留真系统菜单、接受此折叠」（想彻底无折叠只能弃系统菜单改自绘，见 references/rn-pitfalls §④）。
  const trigger = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: fullWidth ? "space-between" : undefined,
        alignSelf: fullWidth ? "stretch" : "flex-start",
        gap: 8,
        height: fullWidth ? 32 : 30,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: fg(fullWidth ? 0.15 : 0.1),
        backgroundColor: fullWidth ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.6)",
        paddingHorizontal: fullWidth ? 8 : 12,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {/* 逐字对齐 dev `<select>` className（proactive-ai-frontend/…/AmbientModelsPanel.tsx）：
          w-full · rounded-md(18) · border-foreground/15 · bg-white/70 · px-2(8) · py-1.5(高≈30)
          · text-label(12) · text-foreground/80 · 常规字重（无 font-medium）。用 dev 源的 12px
          （不是照高倍截图估的 16）→ 文本远小于框、有富余，收菜单时锚点即便瞬时重排也不触发
          截断 → 折叠闪烁消失（= dev 那样不闪，因为 dev 本就 12px 有富余）。mirror 保持紧凑。 */}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: fullWidth ? "Inter_400Regular" : "Inter_500Medium",
          fontSize: fullWidth ? 12 : 11,
          lineHeight: fullWidth ? 16 : 14,
          color: fg(fullWidth ? 0.8 : 0.7),
          flexShrink: 1,
        }}
      >
        {current?.label ?? ""}
      </Text>
      <ChevronsUpDown size={fullWidth ? 14 : 12} strokeWidth={1.75} color={fullWidth ? fg() : fg(0.4)} />
    </View>
  );
  if (disabled) return trigger;
  return (
    <MenuView
      style={fullWidth ? { alignSelf: "stretch", width: "100%" } : undefined}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event as T)}
      actions={options.map((o) => ({
        id: o.value,
        title: o.label,
        state: (o.value === value ? "on" : "off") as "on" | "off",
      }))}
    >
      {trigger}
    </MenuView>
  );
}

interface SectionProps {
  kind: ModelKind;
  profiles: ModelProfile[];
  statusById: StatusById;
  mirror: ModelMirror;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onError: (m: string | null) => void;
  refresh: () => Promise<void>;
  setStatusById: React.Dispatch<React.SetStateAction<StatusById>>;
  showAdvanced: boolean;
}

function ModelSection({
  kind,
  profiles,
  statusById,
  mirror,
  busy,
  setBusy,
  onError,
  refresh,
  setStatusById,
  showAdvanced,
}: SectionProps) {
  const { t } = useTranslation(["ambient", "common"]);
  const persister = PERSISTERS[kind];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 选中态异步加载（AsyncStorage）→ 落到 stored / profiles[0]。
  useEffect(() => {
    let mounted = true;
    void persister.read().then((stored) => {
      if (!mounted) return;
      setSelectedId((prev) => {
        if (prev && profiles.some((p) => p.id === prev)) return prev;
        if (stored && profiles.some((p) => p.id === stored)) return stored;
        return profiles[0]?.id ?? null;
      });
    });
    return () => {
      mounted = false;
    };
  }, [profiles, persister]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      void persister.write(id);
    },
    [persister],
  );

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  );
  const selectedStatus = selected ? statusById[selected.id] : undefined;
  const state = selectedStatus?.state ?? "absent";
  const present = state === "present" || state === "verifying";
  const downloading = state === "downloading" || state === "paused";
  const failed = state === "failed";
  const verifying = state === "verifying";
  const verifyOk = selectedStatus?.lastVerifyResult === "ok";
  const verifyFail = selectedStatus?.lastVerifyResult === "fail";

  const downloadLabel = downloading
    ? t("common:status.cancel")
    : present
      ? t("ambient:models.redownload")
      : failed
        ? t("common:status.retry")
        : t("ambient:models.download");

  const handleDownloadOrCancel = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    try {
      if (downloading) {
        await AmbientModels.cancelModelDownload({ id: selected.id });
      } else {
        await AmbientModels.startModelDownload({ id: selected.id, preferredMirror: mirror });
      }
    } catch (err) {
      onError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }, [selected, downloading, mirror, setBusy, onError]);

  const handleVerify = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    setStatusById((prev) => {
      const current = prev[selected.id];
      if (!current) return prev;
      return { ...prev, [selected.id]: { ...current, state: "verifying" } };
    });
    try {
      const result = await AmbientModels.verifyModel({ id: selected.id });
      setStatusById((prev) => {
        const current = prev[selected.id];
        if (!current) return prev;
        return {
          ...prev,
          [selected.id]: {
            ...current,
            state: "present",
            lastVerifiedAt: Date.now(),
            lastVerifyResult: result.ok ? "ok" : "fail",
            lastVerifyOutput: result.output,
            lastVerifyError: result.errorMessage,
          },
        };
      });
    } catch (err) {
      onError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }, [selected, setBusy, onError, setStatusById]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    try {
      await AmbientModels.deleteModel({ id: selected.id });
      const stored = await persister.read();
      if (stored === selected.id) {
        const fallback = profiles.find((p) => p.id !== selected.id && statusById[p.id]?.state === "present");
        if (fallback) {
          await persister.write(fallback.id);
          setSelectedId(fallback.id);
        } else {
          await persister.clear();
          setSelectedId(profiles.find((p) => p.id !== selected.id)?.id ?? null);
        }
      }
      await refresh();
    } catch (err) {
      onError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }, [selected, profiles, statusById, persister, refresh, setBusy, onError]);

  if (profiles.length === 0) return null;
  const pct = selectedStatus
    ? formatPercent(selectedStatus.bytesWritten, selectedStatus.bytesTotal || (selected?.approxBytes ?? 0))
    : 0;

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 13, color: fg(0.45) }}>
        {t("ambient:models.activeLabel", { kind: KIND_LABEL[kind] })}
      </Text>

      {/* 模型选择 —— 对齐 dev `<select>`：单个下拉（系统 UIMenu），选中打勾、记忆选中
          （handleSelect 持久化 AsyncStorage）。选中变 → 下方 repo/file 解释小字随 selected
          变（本就复用 selected）。dot 前缀标下载态（● 已下 / ↓ 下载中）。 */}
      <Select
        fullWidth
        value={selected?.id ?? ""}
        disabled={busy || downloading}
        onChange={handleSelect}
        options={profiles.map((p) => {
          const s = statusById[p.id];
          const dot =
            s?.state === "present" || s?.state === "verifying"
              ? "● "
              : s?.state === "downloading" || s?.state === "paused"
                ? "↓ "
                : "";
          return { value: p.id, label: `${dot}${p.displayName} · ${formatBytes(p.approxBytes)}` };
        })}
      />

      {selected ? (
        <>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
            {selected.repo} / {selected.file}
            {/* notes 来自 native manifest（英文）；有 modelNotes.<id> 翻译则用翻译，
                否则回退 manifest 原文——native 新增模型没配 key 也不空。 */}
            {(() => {
              const note = selected.notes
                ? t(`modelNotes.${selected.id}`, { defaultValue: selected.notes })
                : "";
              return note ? ` · ${note}` : "";
            })()}
          </Text>

          {downloading && selectedStatus ? (
            <View style={{ gap: 4 }}>
              <View style={{ height: 6, borderRadius: 999, backgroundColor: fg(0.1), overflow: "hidden" }}>
                <View style={{ height: "100%", width: `${pct}%`, backgroundColor: fg(0.6) }} />
              </View>
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45), ...MONO }}>
                {formatBytes(selectedStatus.bytesWritten)} /{" "}
                {formatBytes(selectedStatus.bytesTotal || selected.approxBytes)} · {pct}%
                {selectedStatus.mirrorInUse ? ` · ${t("ambient:models.viaMirror", { mirror: selectedStatus.mirrorInUse })}` : ""}
              </Text>
            </View>
          ) : null}

          {present && selectedStatus?.sizeOnDisk ? (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45), ...MONO }}>
              {t("ambient:models.onDisk", { size: formatBytes(selectedStatus.sizeOnDisk) })}
            </Text>
          ) : null}

          {failed && selectedStatus?.errorMessage ? (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: DESTRUCTIVE }}>
              {selectedStatus.errorMessage}
            </Text>
          ) : null}

          <View className="flex-row items-center" style={{ gap: 8, paddingTop: 2 }}>
            <Pressable onPress={() => void handleDownloadOrCancel()} disabled={busy && !downloading} style={{ flex: 1 }}>
              <View
                style={{
                  borderRadius: 18,
                  alignItems: "center",
                  paddingVertical: 9,
                  backgroundColor: fg(),
                  opacity: busy && !downloading ? 0.4 : 1,
                }}
              >
                <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: bg() }}>{downloadLabel}</Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => void handleDelete()}
              disabled={!present || busy}
              accessibilityRole="button"
              accessibilityLabel={t("ambient:models.deleteAria", { name: selected.displayName })}
            >
              <View
                style={{
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: fg(0.15),
                  paddingHorizontal: 10,
                  paddingVertical: 9,
                  opacity: !present || busy ? 0.4 : 1,
                }}
              >
                <Trash2 size={12} strokeWidth={1.75} color={DESTRUCTIVE} />
              </View>
            </Pressable>
          </View>

          {showAdvanced ? (
            <View style={{ paddingTop: 6, borderTopWidth: 1, borderTopColor: fg(0.1), marginTop: 6, gap: 4 }}>
              <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45), flex: 1 }}>
                  {t("ambient:models.manualVerify")}
                </Text>
                <Pressable onPress={() => void handleVerify()} disabled={!present || busy || verifying} hitSlop={6}>
                  <View className="flex-row items-center" style={{ gap: 4, opacity: !present || busy || verifying ? 0.4 : 1 }}>
                    {verifying ? <Spinner /> : null}
                    <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, color: fg(0.7), textDecorationLine: "underline" }}>
                      {verifying ? t("ambient:models.verifying") : t("ambient:models.runVerify")}
                    </Text>
                  </View>
                </Pressable>
              </View>
              {(verifyOk || verifyFail) && selectedStatus ? (
                <View className="flex-row items-start" style={{ gap: 6 }}>
                  {verifyOk ? (
                    <CheckCircle2 size={11} strokeWidth={1.75} color={EMERALD} style={{ marginTop: 1 }} />
                  ) : (
                    <XCircle size={11} strokeWidth={1.75} color={DESTRUCTIVE} style={{ marginTop: 1 }} />
                  )}
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: verifyOk ? EMERALD : DESTRUCTIVE, flex: 1 }}>
                    {verifyOk
                      ? selectedStatus.lastVerifyOutput
                        ? t("ambient:models.verifiedWithOutput", { output: selectedStatus.lastVerifyOutput })
                        : t("ambient:models.verified")
                      : selectedStatus.lastVerifyError
                        ? t("ambient:models.verifyFailedWithError", { error: selectedStatus.lastVerifyError })
                        : t("ambient:models.verifyFailed")}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export default function AmbientModelsPanel() {
  // 外卡头/尾文案在 dev 住 AccountPanel 的 AmbientSubPage（ns account），盒内文案 = dev
  // AmbientModelsPanel（ns ambient）——RN 把两层合在本组件，双 ns 取 dev 同款 key。
  const { t } = useTranslation(["ambient", "account"]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [statusById, setStatusById] = useState<StatusById>({});
  const [mirror, setMirror] = useState<ModelMirror>("hf-mirror");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    void getPreferredMirror().then(setMirror);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { profiles: list, statuses } = await AmbientModels.listModels();
      setProfiles(list);
      const next: StatusById = {};
      for (const s of statuses) next[s.id] = s;
      setStatusById(next);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const onEvent = (evt: ModelDownloadProgressEvent) => {
      if (active) setStatusById((prev) => ({ ...prev, [evt.id]: evt }));
    };
    const subs = [
      AmbientModels.addListener("modelDownloadProgress", onEvent),
      AmbientModels.addListener("modelDownloadDone", onEvent),
    ];
    return () => {
      active = false;
      subs.forEach((s) => s.remove());
    };
  }, []);

  const handleMirrorChange = useCallback((value: ModelMirror) => {
    setMirror(value);
    void setPreferredMirror(value);
  }, []);

  const asrProfiles = useMemo(() => profiles.filter((p) => p.kind === "asr"), [profiles]);
  const llmProfiles = useMemo(() => profiles.filter((p) => p.kind === "llm"), [profiles]);

  return (
    <GlassCard strong className="mt-3 p-4">
      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 18, color: fg() }}>{t("account:ambientPage.modelsTitle")}</Text>
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.42), marginTop: 4 }}>
        {t("account:ambientPage.modelsDescription")}
      </Text>

      {/* models 管理盒（对应 web rounded-xl border bg-foreground/0.03）*/}
      <View
        style={{
          marginTop: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: fg(0.1),
          backgroundColor: fg(0.03),
          padding: 14,
          gap: 12,
        }}
      >
        {/* 头：Cpu + 标题 + mirror chips */}
        <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
          <View className="flex-row items-center" style={{ gap: 8 }}>
            <Cpu size={14} strokeWidth={1.5} color={fg(0.4)} />
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, color: fg(0.5) }}>{t("models.title")}</Text>
          </View>
          {/* dev: "Mirror" 标签(text-micro/10 · foreground/45)+ <select> 下拉。 */}
          <View className="flex-row items-center" style={{ gap: 6 }}>
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, color: fg(0.45) }}>{t("models.mirror")}</Text>
            <Select value={mirror} options={MIRROR_OPTIONS} onChange={handleMirrorChange} />
          </View>
        </View>

        {profiles.length === 0 ? (
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.3), textAlign: "center", paddingVertical: 8 }}>
            {error ? t("models.listFailed", { error }) : t("models.loadingManifest")}
          </Text>
        ) : (
          <>
            <ModelSection
              kind="asr"
              profiles={asrProfiles}
              statusById={statusById}
              mirror={mirror}
              busy={busy}
              setBusy={setBusy}
              onError={setError}
              refresh={refresh}
              setStatusById={setStatusById}
              showAdvanced={advancedOpen}
            />
            <ModelSection
              kind="llm"
              profiles={llmProfiles}
              statusById={statusById}
              mirror={mirror}
              busy={busy}
              setBusy={setBusy}
              onError={setError}
              refresh={refresh}
              setStatusById={setStatusById}
              showAdvanced={advancedOpen}
            />
          </>
        )}

        <Pressable onPress={() => setAdvancedOpen((o) => !o)} hitSlop={6}>
          <View className="flex-row items-center" style={{ gap: 4 }}>
            {advancedOpen ? (
              <ChevronDown size={11} strokeWidth={1.75} color={fg(0.45)} />
            ) : (
              <ChevronRight size={11} strokeWidth={1.75} color={fg(0.45)} />
            )}
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, color: fg(0.45) }}>{t("models.advanced")}</Text>
          </View>
        </Pressable>

        {error && profiles.length > 0 ? (
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: DESTRUCTIVE }}>{error}</Text>
        ) : null}
      </View>

      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45), marginTop: 10 }}>
        {t("account:ambientPage.localStorageNote")}
      </Text>
    </GlassCard>
  );
}
