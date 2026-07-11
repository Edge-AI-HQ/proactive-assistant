/**
 * Auto Generate 设置 —— web `ui-web/account/AutoGenerateSettings.tsx` 的 RN 对应物
 * （Preferences 子页 Generation section 第一块）。开关 + 间隔下拉；文案走 i18n
 * （account:autoGenerate.* / duration.* / every，与 dev 同 key）。
 * dev 的间隔 `<select>` 在 iOS WKWebView 被系统渲染成原生菜单 → RN 用 MenuView
 * 拿同一个系统 UIMenu（本项目 Select 既定做法），关闭态触发框逐字对齐
 * dev select className：text-caption(11) · bg-background(实底) · border-foreground/15
 * · rounded(4) · px-2 py-1 · disabled:opacity-40。
 */
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import { useUserSettings } from "@pin-ai/state";

import i18n from "../../i18n";
import { Spinner } from "../../ui/Spinner";
import { SettingsSwitch } from "./SettingsSwitch";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "hsl(220, 30%, 96%)";
const EMERALD_500 = "#10b981";
const RED_500 = "#ef4444";

// Preset interval buckets surfaced in the UI. Server enforces 1–1440min
// via Pydantic / DB CHECK; the bucket list here is purely UX. Minute-level
// ticks are affordable because the generator's context is prompt-cache
// stable (anchor architecture) — each tick re-pays only the uncached tail.
const PRESETS_MINUTES = [1, 3, 5, 15, 30, 60] as const;

function formatPreset(min: number): string {
  if (min < 60) return i18n.t("account:duration.minutes", { value: min });
  if (min % 60 !== 0) return i18n.t("account:duration.hours", { value: (min / 60).toFixed(1) });
  const h = min / 60;
  if (h < 24) return i18n.t("account:duration.hours", { value: h });
  return i18n.t("account:duration.days", { count: h / 24 });
}

export default function AutoGenerateSettings() {
  const { t } = useTranslation("account");
  const { settings, loading, saving, error, patch } = useUserSettings();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  // Defaults match the DB column DEFAULTs (`pai_user_settings`):
  // auto_generate=TRUE, interval=60min (migration 126). Server lazy-creates
  // the row with these on first GET, so this fallback is only the
  // loading-flash visual before the response lands.
  const enabled = settings?.autoGenerate ?? true;
  const intervalMinutes = settings?.autoGenerateIntervalMinutes ?? 60;

  const flashSaved = () => {
    setSavedAt(Date.now());
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedAt(null), 1500);
  };

  const handleToggle = async () => {
    const next = !enabled;
    if (await patch({ autoGenerate: next })) flashSaved();
  };

  const handleIntervalChange = async (next: number) => {
    if (!Number.isFinite(next) || next === intervalMinutes) return;
    if (await patch({ autoGenerateIntervalMinutes: next })) flashSaved();
  };

  const selectDisabled = loading || saving || !enabled;
  const trigger = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        borderRadius: 4,
        borderWidth: 1,
        borderColor: fg(0.15),
        backgroundColor: BG,
        paddingHorizontal: 8,
        paddingVertical: 4,
        opacity: selectDisabled ? 0.4 : 1,
      }}
    >
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg() }}>
        {formatPreset(intervalMinutes)}
      </Text>
    </View>
  );

  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20, color: fg(0.8) }}>
            {t("autoGenerate.title")}
          </Text>
          {saving ? <Spinner size={12} color={fg(0.4)} /> : null}
          {!saving && savedAt ? <Check size={12} color={EMERALD_500} /> : null}
        </View>
        <SettingsSwitch size="sm" on={enabled} disabled={loading || saving} onPress={() => void handleToggle()} />
      </View>
      <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.4) }}>
        {t("autoGenerate.description")}
      </Text>
      <View style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.6) }}>{t("every")}</Text>
        {selectDisabled ? (
          trigger
        ) : (
          <MenuView
            shouldOpenOnLongPress={false}
            onPressAction={({ nativeEvent }) => void handleIntervalChange(Number(nativeEvent.event))}
            actions={PRESETS_MINUTES.map((m) => ({
              id: String(m),
              title: formatPreset(m),
              state: (m === intervalMinutes ? "on" : "off") as "on" | "off",
            }))}
          >
            {trigger}
          </MenuView>
        )}
      </View>
      {error ? (
        <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: RED_500 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
