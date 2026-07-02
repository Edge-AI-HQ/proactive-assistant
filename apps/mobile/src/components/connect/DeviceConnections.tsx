/**
 * Hardware Devices 列表——web `ui-web/connect/DeviceConnections.tsx` 的 RN
 * 介质版（mesh 卡展开内容）。数据复用 @pin-ai/state useUserDevices；点行下钻
 * DeviceTimeline。介质映射：web `confirm()`（dev = WKWebView 系统确认弹窗）→
 * `Alert.alert` 系统对话框（Cancel / Remove destructive）；revoke 的 Trash 钮
 * web hover 显 → RN 常显。
 */
import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Apple,
  Bot,
  ChevronRight,
  Cpu,
  Smartphone,
  Trash2,
  Watch,
  type LucideIcon,
} from "lucide-react-native";
import { useUserDevices } from "@pin-ai/state";
import type { UserDevice, UserDevicePlatform } from "@pin-ai/core";

import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";
import { formatRelativeTime } from "../../lib/format";
import DeviceTimeline from "./DeviceTimeline";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;

export default function DeviceConnections() {
  const { t } = useTranslation("connect");
  const { devices, loading, error, revoke, refresh } = useUserDevices(true);
  const [selectedDevice, setSelectedDevice] = useState<UserDevice | null>(null);

  const peerDevices = useMemo(() => devices.filter((d) => d.platform !== "web"), [devices]);

  if (selectedDevice) {
    return <DeviceTimeline device={selectedDevice} onBack={() => setSelectedDevice(null)} />;
  }

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading && peerDevices.length === 0 ? (
        <View style={styles.loadingRow}>
          <Spinner size={12} color={fg(0.5)} />
          <Text style={styles.loadingText}>{t("deviceConnections.loading")}</Text>
        </View>
      ) : peerDevices.length === 0 ? (
        <Text style={styles.emptyText}>{t("deviceConnections.empty")}</Text>
      ) : (
        <View style={{ gap: 8 }}>
          {peerDevices.map((d) => (
            <DeviceRow
              key={d.device_id}
              device={d}
              onOpen={() => setSelectedDevice(d)}
              onRevoke={() => {
                const name = d.display_name ?? d.device_id;
                // web confirm(removeConfirm) → 系统对话框（按钮文案是 RN 加的，web 用浏览器原生钮）。
                Alert.alert(t("deviceConnections.removeConfirm", { name }), undefined, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Remove", style: "destructive", onPress: () => void revoke(d.device_id) },
                ]);
              }}
            />
          ))}
        </View>
      )}

      <View style={styles.refreshRow}>
        <Pressable onPress={() => void refresh()} accessibilityRole="button">
          <Text style={styles.refreshText}>{t("deviceConnections.refresh")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Device row ──────────────────────────────────────────────────────────

function DeviceRow({
  device,
  onOpen,
  onRevoke,
}: {
  device: UserDevice;
  onOpen: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("connect");
  const platform = platformDisplay(device.platform);
  const Icon = platform.Icon;
  const platformLabel = t(`deviceConnections.platform.${platform.labelKey}`);
  const lastSeen = device.last_seen_at
    ? safeRelativeTime(device.last_seen_at)
    : t("deviceConnections.never");
  const detail = [device.model, t("deviceConnections.lastSeen", { time: lastSeen })]
    .filter(Boolean)
    .join(" · ");

  return (
    <GlassCard style={styles.deviceRow}>
      <View
        style={[styles.deviceIconBox, { backgroundColor: platform.iconBg }]}
        accessibilityRole="image"
        accessibilityLabel={t("deviceConnections.deviceAria", { platform: platformLabel })}
      >
        <Icon size={16} color={platform.iconColor} />
      </View>
      <Pressable onPress={onOpen} accessibilityRole="button" style={styles.flex1MinW0}>
        <View>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.display_name ?? device.device_id}
          </Text>
          <View style={styles.deviceMetaRow}>
            <View style={[styles.platformBadge, { backgroundColor: platform.badgeBg }]}>
              <Text style={[styles.platformBadgeText, { color: platform.badgeColor }]}>
                {platformLabel}
              </Text>
            </View>
            <Text style={styles.deviceDetail} numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>
      </Pressable>
      <Pressable
        onPress={onRevoke}
        accessibilityRole="button"
        accessibilityLabel={t("deviceConnections.revokeDevice")}
        hitSlop={6}
      >
        <Trash2 size={14} color={fg(0.4)} />
      </Pressable>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t("deviceConnections.openTimeline")}
        hitSlop={6}
      >
        <ChevronRight size={16} color={fg(0.4)} />
      </Pressable>
    </GlassCard>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

type PlatformLabelKey = "ios" | "android" | "wearable" | "sensor" | "embedded" | "web";

/** web platformDisplay 的色板（tailwind → hex；本 app 无 dark mode，取 light 分支）。 */
function platformDisplay(p: UserDevicePlatform): {
  Icon: LucideIcon;
  labelKey: PlatformLabelKey;
  iconBg: string;
  iconColor: string;
  badgeBg: string;
  badgeColor: string;
} {
  if (p === "ios") {
    return {
      Icon: Apple,
      labelKey: "ios",
      iconBg: "#171717", // neutral-900
      iconColor: "#ffffff",
      badgeBg: "rgba(115,115,115,0.1)", // neutral-500/10
      badgeColor: fg(0.6),
    };
  }
  if (p === "android") {
    return {
      Icon: Bot,
      labelKey: "android",
      iconBg: "rgba(16,185,129,0.12)",
      iconColor: "#047857",
      badgeBg: "rgba(16,185,129,0.1)",
      badgeColor: "#047857",
    };
  }
  if (p === "wearable") {
    return {
      Icon: Watch,
      labelKey: "wearable",
      iconBg: "rgba(14,165,233,0.12)",
      iconColor: "#0369a1",
      badgeBg: "rgba(14,165,233,0.1)",
      badgeColor: "#0369a1",
    };
  }
  if (p === "sensor") {
    return {
      Icon: Activity,
      labelKey: "sensor",
      iconBg: "rgba(245,158,11,0.12)",
      iconColor: "#b45309",
      badgeBg: "rgba(245,158,11,0.1)",
      badgeColor: "#b45309",
    };
  }
  if (p === "embedded") {
    return {
      Icon: Cpu,
      labelKey: "embedded",
      iconBg: "rgba(139,92,246,0.12)",
      iconColor: "#6d28d9",
      badgeBg: "rgba(139,92,246,0.1)",
      badgeColor: "#6d28d9",
    };
  }
  return {
    Icon: Smartphone,
    labelKey: "web",
    iconBg: fg(0.05),
    iconColor: fg(0.6),
    badgeBg: fg(0.05),
    badgeColor: fg(0.5),
  };
}

/** locale 相对时间 + 旧防御兜底（解析失败原样 ISO）。 */
function safeRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return formatRelativeTime(parsed);
}

const styles = StyleSheet.create({
  flex1MinW0: { flex: 1, minWidth: 0 },
  errorBox: { borderRadius: 8, backgroundColor: "rgba(239,68,68,0.1)", paddingHorizontal: 8, paddingVertical: 6 },
  errorText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: "rgba(239,68,68,0.8)" },
  loadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16 },
  loadingText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.5) },
  emptyText: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
    color: fg(0.4),
    textAlign: "center",
    paddingVertical: 16,
  },

  deviceRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  deviceIconBox: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  deviceName: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_500Medium", color: "#1d2130" },
  deviceMetaRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  platformBadge: { borderRadius: 16, paddingHorizontal: 6, paddingVertical: 2 },
  platformBadgeText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium" },
  deviceDetail: { flexShrink: 1, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },

  refreshRow: { alignItems: "flex-end", paddingTop: 4 },
  refreshText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.4) },
});
