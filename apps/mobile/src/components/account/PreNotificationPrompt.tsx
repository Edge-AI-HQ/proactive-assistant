/**
 * In-app pre-prompt for notification permission —— dev
 * `proactive-ai-frontend/src/components/common/PreNotificationPrompt.tsx` 的
 * RN 对应物 + dev `AppLayout.tsx` 预询流接线（273-300 gate / 1030-1041 handlers）
 * 的合体：AppShell 禁碰壳内逻辑，故 gate + patch 收进本组件，挂载只需一行
 * `<PreNotificationPrompt userId={user.id} />`（AppShell 主屏层，CardChatScreen 后）。
 *
 * Why a pre-prompt before the OS prompt（dev 原注释）：
 *   - We can explain the WHY (async card generation). The OS dialog
 *     only gets one short system-rendered line.
 *   - Once denied at the OS level, iOS won't show that prompt again.
 *     If the user is in the "not sure" zone, the pre-prompt lets them
 *     defer without burning the OS permission slot.
 *
 * 语义逐字对齐 dev：
 *   - 显隐：ready && settings 已加载 && notifyPermissionPromptedAt == null &&
 *     OS 态可询问（"prompt"）。granted / denied 直接跳过并自动盖章（auto-stamp
 *     effect），下次冷启不再重评。
 *   - Turn on → OS 询问 → 一次 patch：notifyPermissionPrompted:true +
 *     （granted 才）notifyNewCards:true。Later / 点背景 → 只盖章。两条路都
 *     盖章，永不自动重弹；设置 → Notifications 开关是唯一后悔药。
 *   - busy 期间 sheet 保持挂载（网络往返无 flash-of-empty），按钮禁用。
 *
 * 介质差异：web 的 Escape=Later 无 RN 对应（iOS 无硬件 Esc）；背景点击=Later
 * 照搬。静态 bottom-sheet modal（dev 刻意不用 vaul drawer，RN 同样无动画）。
 * 出血用 FullBleedOverlay（逃出 App 根 SafeAreaView，sheet 贴物理屏底，
 * = dev fixed inset-0 的 WKWebView 全出血）。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Bell } from "lucide-react-native";
import { useUserSettings } from "@pin-ai/state";

import { FullBleedOverlay } from "../app/FullBleedOverlay";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { EM_TIGHT, tracking } from "../../ui/typography";

// web CSS 变量（proactive-ai-frontend/src/index.css）→ 内联色。NativeWind 的
// hsl(var()) 无 alpha 槽，带透明度色必须内联 hsla（同 SettingScreen/DebugPanel）。
const FOREGROUND = "hsl(230, 25%, 15%)"; // --foreground
const BACKGROUND = "hsl(220, 30%, 96%)"; // --background
const BORDER = "hsl(220, 20%, 88%)"; // --border
const PRIMARY = "hsl(292, 78%, 63%)"; // --primary
const PRIMARY_10 = "hsla(292, 78%, 63%, 0.1)"; // bg-primary/10
const PRIMARY_FOREGROUND = "hsl(0, 0%, 100%)"; // --primary-foreground
const MUTED_FOREGROUND = "hsl(220, 10%, 50%)"; // --muted-foreground

export interface PreNotificationPromptSheetProps {
  open: boolean;
  /** Called when the user taps "Turn on". Should request OS permission
   * and stamp notifyPermissionPromptedAt + (on grant) notifyNewCards=true.
   * Resolves after the parent finishes its write so the sheet stays
   * mounted during the network round-trip — no flash-of-empty. */
  onAccept: () => Promise<void>;
  /** Called when the user taps "Later". Should stamp
   * notifyPermissionPromptedAt only (don't touch notifyNewCards). */
  onDecline: () => Promise<void>;
}

/** 纯呈现 sheet（= dev PreNotificationPrompt 组件，props 同名同义）。 */
export function PreNotificationPromptSheet({
  open,
  onAccept,
  onDecline,
}: PreNotificationPromptSheetProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const handleAccept = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  }, [busy, onAccept]);

  const handleDecline = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecline();
    } finally {
      setBusy(false);
    }
  }, [busy, onDecline]);

  if (!open) return null;

  return (
    <FullBleedOverlay>
      <View style={[StyleSheet.absoluteFill, styles.container]}>
        {/* Backdrop — tapping outside counts as "Later", same outcome as the
            explicit button, so we don't drop the prompted_at stamp. */}
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={() => void handleDecline()}
          accessibilityRole="button"
          accessibilityLabel={t("notificationPrompt.later")}
        />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.body}>
            <View style={styles.iconCircle}>
              <Bell size={24} color={PRIMARY} />
            </View>
            <Text style={styles.title}>{t("notificationPrompt.title")}</Text>
            <Text style={styles.description}>{t("notificationPrompt.description")}</Text>
          </View>
          <View style={styles.footer}>
            <Pressable
              onPress={() => void handleAccept()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t("notificationPrompt.turnOn")}
            >
              <View style={[styles.acceptBtn, busy && styles.btnDisabled]}>
                <Text style={styles.acceptText}>{t("notificationPrompt.turnOn")}</Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => void handleDecline()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t("notificationPrompt.later")}
            >
              <View style={[styles.laterBtn, busy && styles.btnDisabled]}>
                <Text style={styles.laterText}>{t("notificationPrompt.later")}</Text>
              </View>
            </Pressable>
          </View>
        </View>
      </View>
    </FullBleedOverlay>
  );
}

/**
 * 预询流容器（= dev AppLayout 的 gate + handlers）。settings 走共享 TQ cache
 * （Root 实例已填），patch 走同一 useUserSettings；OS 态走 usePushNotifications。
 */
export default function PreNotificationPrompt({ userId }: { userId: string }) {
  const { settings, patch } = useUserSettings();
  const push = usePushNotifications(userId);
  // expo 无 "prompt-with-rationale"（undetermined → "prompt"），osPromptable
  // 只剩一个态；web 端 hook 恒 "unsupported"，永不可询问（= dev isNative gate）。
  const osPromptable = push.permissionState === "prompt";
  const show =
    push.ready &&
    settings != null &&
    settings.notifyPermissionPromptedAt == null &&
    osPromptable;

  // Auto-stamp prompted_at when state is already decided (granted / denied
  // at app boot, e.g. user previously installed and answered, or an existing
  // user from before the sheet existed). Without this the show gate would
  // still be null but `osPromptable` is false — fine, sheet doesn't show —
  // yet on next cold start we'd re-evaluate the same condition. Stamp once
  // and stop re-checking.（dev AppLayout:291-300 逐字。）
  useEffect(() => {
    if (push.permissionState === "unsupported" || !push.ready) return;
    if (!settings) return;
    if (settings.notifyPermissionPromptedAt != null) return;
    if (osPromptable) return; // sheet will handle it
    void patch({ notifyPermissionPrompted: true });
  }, [push.permissionState, push.ready, osPromptable, settings, patch]);

  return (
    <PreNotificationPromptSheet
      open={show}
      onAccept={async () => {
        // dev AppLayout:1032-1038 逐字：OS 询问 → 一次 patch（盖章 + granted
        // 才开 notifyNewCards）。
        const nextPermission = await push.requestPermission();
        await patch({
          notifyPermissionPrompted: true,
          ...(nextPermission === "granted" ? { notifyNewCards: true } : {}),
        });
      }}
      onDecline={async () => {
        await patch({ notifyPermissionPrompted: true });
      }}
    />
  );
}

const styles = StyleSheet.create({
  // dev: fixed inset-0 z-50 flex items-end justify-center。
  container: { justifyContent: "flex-end", alignItems: "center" },
  // dev: bg-black/40。
  backdrop: { backgroundColor: "rgba(0,0,0,0.4)" },
  // dev: mx-auto w-full max-w-md rounded-t-[10px] border bg-background pb-6。
  sheet: {
    width: "100%",
    maxWidth: 448,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: BACKGROUND,
    paddingBottom: 24,
  },
  // dev: flex flex-col items-center gap-3 p-4 pt-5 text-center。
  body: { alignItems: "center", gap: 12, padding: 16, paddingTop: 20 },
  // dev: rounded-full bg-primary/10 p-3。
  iconCircle: { borderRadius: 999, backgroundColor: PRIMARY_10, padding: 12 },
  // dev: text-lg font-semibold leading-none tracking-tight。
  title: {
    fontSize: 18,
    lineHeight: 18,
    letterSpacing: tracking(18, EM_TIGHT),
    color: FOREGROUND,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  // dev: text-base leading-relaxed text-muted-foreground。
  description: {
    fontSize: 16,
    lineHeight: 26,
    color: MUTED_FOREGROUND,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  // dev: flex flex-col gap-2 p-4。
  footer: { gap: 8, padding: 16 },
  // dev: w-full rounded-md bg-primary text-primary-foreground py-3 text-sm
  // font-medium（rounded-md = calc(var(--radius) 1.25rem − 2px) = 18）。
  acceptBtn: {
    alignItems: "center",
    borderRadius: 18,
    backgroundColor: PRIMARY,
    paddingVertical: 12,
  },
  acceptText: { fontSize: 14, lineHeight: 20, color: PRIMARY_FOREGROUND, fontFamily: "Inter_500Medium" },
  // dev: w-full rounded-md bg-transparent text-muted-foreground py-3 text-sm。
  laterBtn: { alignItems: "center", borderRadius: 18, paddingVertical: 12 },
  laterText: { fontSize: 14, lineHeight: 20, color: MUTED_FOREGROUND, fontFamily: "Inter_400Regular" },
  // dev: disabled:opacity-60。
  btnDisabled: { opacity: 0.6 },
});
