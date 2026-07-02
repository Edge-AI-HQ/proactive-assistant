/**
 * 生成语言设置 —— web `ui-web/account/GenerationLanguageSettings.tsx` 的 RN 对应物
 * （Preferences 子页 Generation section 第二块）。dev 的 `<select>`（appearance-none
 * + 自绘 ChevronDown）在 iOS 弹系统菜单 → RN 用 MenuView 拿同一个系统 UIMenu；
 * 关闭态触发框逐字对齐 dev className：rounded-lg(20) · border-foreground/10 ·
 * bg-white/60 · px-3 py-1.5 · text-sm(14) + ChevronDown 14 / foreground-40。
 */
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import { GENERATION_LANGUAGE_OPTIONS, type SupportedGenerationLanguage } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import { Spinner } from "../../ui/Spinner";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const EMERALD_500 = "#10b981";
const RED_500 = "#ef4444";

export default function GenerationLanguageSettings() {
  const { t } = useTranslation("account");
  const { settings, loading, saving, error, patch } = useUserSettings();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const handleChange = async (next: SupportedGenerationLanguage) => {
    if (!settings || next === settings.generationLanguage) return;
    const result = await patch({ generationLanguage: next });
    if (result) {
      setSavedAt(Date.now());
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedAt(null), 1500);
    }
  };

  const value = settings?.generationLanguage ?? "en";
  const current = GENERATION_LANGUAGE_OPTIONS.find((o) => o.value === value);
  const disabled = loading || saving;

  const trigger = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: fg(0.1),
        backgroundColor: "rgba(255,255,255,0.6)",
        paddingLeft: 12,
        paddingRight: 8,
        paddingVertical: 6,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 20, color: fg() }}>
        {current?.label ?? value}
      </Text>
      <ChevronDown size={14} strokeWidth={2} color={fg(0.4)} />
    </View>
  );

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20, color: fg(0.8) }}>
            {t("language.title")}
          </Text>
          {saving ? <Spinner size={12} color={fg(0.4)} /> : null}
          {!saving && savedAt ? <Check size={12} color={EMERALD_500} /> : null}
        </View>
        {disabled ? (
          trigger
        ) : (
          <MenuView
            shouldOpenOnLongPress={false}
            onPressAction={({ nativeEvent }) =>
              void handleChange(nativeEvent.event as SupportedGenerationLanguage)
            }
            actions={GENERATION_LANGUAGE_OPTIONS.map((o) => ({
              id: o.value,
              title: o.label,
              state: (o.value === value ? "on" : "off") as "on" | "off",
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
