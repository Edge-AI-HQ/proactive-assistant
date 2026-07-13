/**
 * AmbientSourceControlsPanel — web 同名组件的 RN 对应物（settings → Ambient 子页第①块）。
 * web 源：proactive-ai-frontend/src/components/ambient/AmbientSourceControlsPanel.tsx。
 *
 * 功能完全对齐生产端：
 *  - 面板头（Radio + "Permissions & sources" + ShieldCheck + 副标题 + "{n} on"）。
 *  - "Enable all" 整宽钮。
 *  - 9 个源行：标签 + 权限徽 + running 徽 + 提示 + On/Off/Saving 钮 +
 *    实时遥测行（最后事件时间 · 摘要 · ✓采集计数）+ 错误。
 *  - 底部 runtime 统计（buf · outbox · ingested · err）+ Flush 钮 + last drain 时间。
 *  - toggle / Enable all 改 consent 后 reconcile 实时启停对应源（@pin-ai/state.patch
 *    存 consent + ambient/runtime.reconcileEnabledSources 调和正在跑的采集）。
 *
 * RN 架构差异（忠实映射）：bufferSize 恒 0、outboxMode 恒 "sqlite"；Flush = 立即
 * drain（按 outboxPending>0 启用，web 是按 bufferSize）。遥测真值需真机（模拟器无真传感器）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { CheckCircle2, Radio, ShieldCheck } from "lucide-react-native";
import { useUserSettings } from "@pin-ai/state";

import { GlassCard } from "../../ui/GlassCard";
import { AMBIENT_BULK_SOURCE_KEYS, AMBIENT_SOURCE_KEYS, type AmbientSourceKey } from "../../ambient/keys";
import {
  ambientStatusSnapshot,
  currentGateEpoch,
  flushAmbient,
  getAmbientEnabledSnapshot,
  reconcileEnabledSources,
  subscribeAmbientStatus,
} from "../../ambient/runtime";
import { usePageActive } from "../app/KeepAlivePage";
import type { RuntimeStatus, SourceStatus } from "../../ambient/status";

// --foreground / --background 通道值（对齐 AmbientScreen / SettingScreen）。NativeWind 的
// hsl(var()) 无 alpha 槽 → 带透明度色一律内联 hsla，保证渲染。
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "220, 30%, 96%";
const bg = (a?: number) => (a === undefined ? `hsl(${BG})` : `hsla(${BG}, ${a})`);
const DESTRUCTIVE = "hsl(0, 72%, 60%)"; // web --destructive（亮红/珊瑚红）
const EMERALD = "#047857"; // emerald-700（running 徽文字）
const EMERALD_BG = "rgba(16, 185, 129, 0.1)"; // emerald-500/10（running 徽底）
const MONO = { fontVariant: ["tabular-nums" as const] };
// web `font-mono tabular-nums`：仅遥测行的「时间 + ✓计数」用等宽（Menlo = RN iOS 等宽，
// 对齐 web font-mono，让 ✓ 与数字落在等宽网格、不再错位）。底部 stats 是 tabular-nums-only。
const MONO_FONT = { fontFamily: "Menlo", fontVariant: ["tabular-nums" as const] };

// 源元数据（label/permission/hint）住在 locales en/ambient.json 的 sources.meta.<key>，
// 渲染时经 i18n 解析（= dev），不再在本文件硬编码。

// 展示顺序对齐 web `ALL_SOURCE_KEYS`（proactive-ai-frontend/src/services/ambient/keys.ts）。
// AMBIENT_SOURCE_KEYS 是 runtime 的启动序，consent/reconcile/enableAll 仍用它（与顺序无关）；
// 这里只决定「Permissions & sources」面板里源行的渲染先后，逐字对齐 web。
const SOURCE_DISPLAY_ORDER: AmbientSourceKey[] = [
  "sound_classifier",
  "visit",
  "activity",
  "location",
  "health",
  "calendar",
  "focus",
  "audio_route",
  "device_state",
];

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 单源行：标签 + 权限徽 + running 徽 + 提示 + On/Off/Saving 钮 + 遥测行 + 错误。
 * 开关钮状态 = consent（用户设置）；running 徽 = 实际在跑（source.isStarted()）；两者可不同步。
 * Pressable 只管 onPress（本项目 Pressable style 不渲染 → 视觉全在内层 View）。
 */
function SourceRow({
  meta,
  consentEnabled,
  busy,
  status,
  onToggle,
}: {
  meta: { label: string; permission: string; hint: string };
  consentEnabled: boolean;
  busy: boolean;
  status: SourceStatus | undefined;
  onToggle: () => void;
}) {
  const { t } = useTranslation("ambient");
  const running = status?.enabled === true;
  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: fg(0.1),
        backgroundColor: bg(0.45),
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View className="flex-row items-start justify-between" style={{ gap: 12 }}>
        <View className="flex-1">
          <View className="flex-row items-center" style={{ gap: 6, flexWrap: "wrap" }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 16, color: fg() }}>
              {meta.label}
            </Text>
            <View style={{ borderRadius: 999, backgroundColor: fg(0.06), paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.5) }}>
                {meta.permission}
              </Text>
            </View>
            {running ? (
              <View style={{ borderRadius: 999, backgroundColor: EMERALD_BG, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: EMERALD }}>
                  {t("sources.running")}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16.5, color: fg(0.86), marginTop: 4 }}>
            {meta.hint}
          </Text>
        </View>
        <Pressable
          onPress={onToggle}
          disabled={busy}
          hitSlop={6}
          accessibilityRole="switch"
          accessibilityState={{ checked: consentEnabled, disabled: busy }}
          accessibilityLabel={t(consentEnabled ? "sources.disableAria" : "sources.enableAria", { label: meta.label })}
        >
          <View
            style={{
              minHeight: 44,
              minWidth: 64,
              borderRadius: 999,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: consentEnabled ? fg() : fg(0.08),
              opacity: busy ? 0.4 : 1,
            }}
          >
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: consentEnabled ? bg() : fg(0.86) }}>
              {busy ? t("sources.stateSaving") : consentEnabled ? t("sources.stateOn") : t("sources.stateOff")}
            </Text>
          </View>
        </Pressable>
      </View>

      {/* 遥测行：最后事件时间 · 摘要 · ✓采集计数 */}
      <View className="flex-row items-center" style={{ gap: 8, marginTop: 10 }}>
        <Text style={{ fontSize: 10, lineHeight: 14, color: fg(0.4), ...MONO_FONT }}>
          {formatTime(status?.lastEvent?.ts ?? null)}
        </Text>
        <Text numberOfLines={1} className="flex-1" style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) }}>
          {status?.lastEvent?.summary ?? t("sources.noLocalEvent")}
        </Text>
        <Text style={{ fontSize: 10, lineHeight: 14, color: fg(0.4), ...MONO_FONT }}>
          ✓ {status?.ingestedCount ?? 0}
        </Text>
      </View>
      {status?.lastError ? (
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: DESTRUCTIVE, marginTop: 6 }}>
          {status.lastError}
        </Text>
      ) : null}
    </View>
  );
}

export default function AmbientSourceControlsPanel({ userId }: { userId: string | null }) {
  const { t } = useTranslation("ambient");
  const { settings, loading, error, patch } = useUserSettings(userId);
  const [busyKeys, setBusyKeys] = useState<Set<AmbientSourceKey>>(new Set());
  const [bulkEnabling, setBulkEnabling] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);

  // 订阅 runtime 遥测：mount 取一次快照 + 后续变更推送（源捕获/启停/drain 都会 notify）。
  // 按页面可见性门控：settings 是 keep-alive 页,进过 Ambient 子页后本面板常驻挂载,
  // 不门控则每个采集事件都重渲整棵隐藏 settings 树（审查 F4,同 AmbientScreen 一类）。
  // onboarding 挂载点无 Provider → context 默认 true,行为不变。
  const pageActive = usePageActive();
  useEffect(() => {
    if (!pageActive) return;
    let mounted = true;
    const update = () => {
      if (mounted) setStatus(ambientStatusSnapshot());
    };
    update();
    const unsub = subscribeAmbientStatus(update);
    return () => {
      mounted = false;
      unsub();
    };
  }, [pageActive]);

  const statusByKey = useMemo(() => {
    const m = new Map<string, SourceStatus>();
    for (const s of status?.sources ?? []) m.set(s.key, s);
    return m;
  }, [status]);

  // 计数/全开判断只看批量键——pin_hardware 由 Connect 设备页管理，不在本面板。
  const enabledSet = useMemo(() => {
    const src = settings?.ambientSources ?? {};
    return new Set(AMBIENT_BULK_SOURCE_KEYS.filter((k) => src[k]?.enabled === true));
  }, [settings?.ambientSources]);
  const enabledCount = enabledSet.size;
  const allOn = enabledCount === AMBIENT_BULK_SOURCE_KEYS.length;

  // consent patch 成功后：**主闸开着**才把"正在跑的源"调和到新 consent 集（实时启停,
  // 交互式补权限）。主闸关着 = 纯授权记录——绝不启动采集、绝不翻闸（2026-07-05 语义
  // 拍板：本面板是权限管理、不是 ambient 开关;采集运行 ⇔ 主闸开 && 有授权。此前实现
  // 经 reconcile 顺手置闸+开采,是"授权即开采"bug 的入口）。
  const reconcileFrom = useCallback(
    async (ambientSources: Record<string, { enabled?: boolean } | null> | undefined) => {
      if (!userId) return;
      // 同步读镜像（非 AsyncStorage 往返）+ 捕获关闸代际：读闸后闸被关 → reconcile
      // 整体作废（F1）。镜像未预热(null)按关处理——安全方向。
      const gateEpoch = currentGateEpoch();
      if (getAmbientEnabledSnapshot() !== true) return;
      const enabled = AMBIENT_SOURCE_KEYS.filter((k) => ambientSources?.[k]?.enabled === true);
      await reconcileEnabledSources(userId, enabled, { gateEpoch });
    },
    [userId],
  );

  const toggle = useCallback(
    async (key: AmbientSourceKey, currentlyEnabled: boolean) => {
      setBusyKeys((prev) => new Set(prev).add(key));
      try {
        const ambientSources: Record<string, { enabled: boolean }> = {
          [key]: { enabled: !currentlyEnabled },
        };
        // 手机麦克风与 PIN 硬件收录互斥：开手机源时同一 patch 里关掉硬件源，
        // reconcileFrom 会停 BLE capture。
        if (key === "sound_classifier" && !currentlyEnabled
          && settings?.ambientSources?.pin_hardware?.enabled === true) {
          ambientSources.pin_hardware = { enabled: false };
        }
        const updated = await patch({ ambientSources });
        if (updated) await reconcileFrom(updated.ambientSources);
      } finally {
        setBusyKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [patch, reconcileFrom, settings?.ambientSources?.pin_hardware?.enabled],
  );

  const enableAll = useCallback(async () => {
    if (allOn) return;
    setBulkEnabling(true);
    try {
      const ambientSources: Record<string, { enabled: boolean }> = {};
      AMBIENT_BULK_SOURCE_KEYS.forEach((k) => {
        ambientSources[k] = { enabled: true };
      });
      // 批量开含手机麦克风源，与 PIN 硬件收录互斥——同 patch 关掉硬件源。
      if (settings?.ambientSources?.pin_hardware?.enabled === true) {
        ambientSources.pin_hardware = { enabled: false };
      }
      const updated = await patch({ ambientSources });
      if (updated) await reconcileFrom(updated.ambientSources);
    } finally {
      setBulkEnabling(false);
    }
  }, [allOn, patch, reconcileFrom, settings?.ambientSources?.pin_hardware?.enabled]);

  const flush = useCallback(async () => {
    await flushAmbient();
  }, []);

  const enableAllDisabled = loading || bulkEnabling || allOn;

  return (
    <GlassCard strong className="p-4">
      {/* 面板头：图标 + 标题 + ShieldCheck + 副标题 + 计数徽 */}
      <View className="flex-row items-start justify-between" style={{ gap: 12 }}>
        <View className="flex-1 flex-row items-start" style={{ gap: 10 }}>
          <View
            style={{
              marginTop: 2,
              width: 32,
              height: 32,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: fg(0.06),
            }}
          >
            <Radio size={15} strokeWidth={1.8} color={fg(0.6)} />
          </View>
          <View className="flex-1">
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 16, lineHeight: 20, color: fg() }}>
                {t("sources.title")}
              </Text>
              <ShieldCheck size={13} strokeWidth={1.8} color={fg(0.42)} />
            </View>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18, color: fg(0.55), marginTop: 4 }}>
              {t("sources.subtitle")}
            </Text>
          </View>
        </View>
        <View style={{ borderRadius: 999, backgroundColor: fg(0.06), paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
            {t("sources.enabledCount", { n: enabledCount })}
          </Text>
        </View>
      </View>

      {/* Enable all */}
      <Pressable
        onPress={() => void enableAll()}
        disabled={enableAllDisabled}
        accessibilityRole="button"
        accessibilityLabel={t("sources.enableAllAria")}
        style={{ marginTop: 12 }}
      >
        <View
          style={{
            minHeight: 40,
            borderRadius: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            backgroundColor: fg(),
            opacity: enableAllDisabled ? 0.4 : 1,
          }}
        >
          <CheckCircle2 size={14} strokeWidth={2} color={bg()} />
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: bg() }}>
            {bulkEnabling ? t("sources.enabling") : allOn ? t("sources.allOn") : t("sources.enableAll")}
          </Text>
        </View>
      </Pressable>

      {/* 源行 */}
      {loading ? (
        <View
          style={{
            marginTop: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: fg(0.1),
            backgroundColor: fg(0.03),
            padding: 12,
          }}
        >
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: fg(0.45) }}>
            {t("sources.loadingPermissions")}
          </Text>
        </View>
      ) : (
        <View style={{ marginTop: 12, gap: 8 }}>
          {SOURCE_DISPLAY_ORDER.map((key) => (
            <SourceRow
              key={key}
              meta={{
                label: t(`sources.meta.${key}.label`),
                permission: t(`sources.meta.${key}.permission`),
                hint: t(`sources.meta.${key}.hint`),
              }}
              consentEnabled={enabledSet.has(key)}
              busy={busyKeys.has(key)}
              status={statusByKey.get(key)}
              onToggle={() => void toggle(key, enabledSet.has(key))}
            />
          ))}
        </View>
      )}

      {/* 底部 runtime 统计 + Flush */}
      {status ? (
        <View
          style={{
            marginTop: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: fg(0.08),
            backgroundColor: fg(0.025),
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
            <Text className="flex-1" style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.78), ...MONO }}>
              {t("sources.stats", {
                buffer: status.bufferSize,
                outbox: status.outboxPendingCount,
                ingested: status.totalIngested,
              })}
              {status.totalIngestErrors > 0 ? t("sources.statsErrors", { n: status.totalIngestErrors }) : ""}
            </Text>
            <Pressable
              onPress={() => void flush()}
              disabled={status.outboxPendingCount === 0}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Flush pending signals now"
            >
              <View
                style={{
                  minHeight: 44,
                  minWidth: 64,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: fg(0.08),
                  opacity: status.outboxPendingCount === 0 ? 0.4 : 1,
                }}
              >
                <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 11, color: fg(0.86) }}>{t("sources.flush")}</Text>
              </View>
            </Pressable>
          </View>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.74), marginTop: 4, ...MONO }}>
            {t("sources.lastTimes", {
              ok: formatTime(status.lastSuccessfulDrainTs),
              drain: formatTime(status.lastDrainTs),
            })}
          </Text>
          {status.lastIngestError ? (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: DESTRUCTIVE, marginTop: 6 }}>
              {t("sources.ingestError", { error: status.lastIngestError })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {error ? (
        <Text style={{ marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: DESTRUCTIVE }}>
          {error}
        </Text>
      ) : null}
    </GlassCard>
  );
}
