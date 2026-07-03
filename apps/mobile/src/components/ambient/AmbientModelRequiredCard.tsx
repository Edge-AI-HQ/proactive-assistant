/**
 * AmbientModelRequiredCard —— dev components/ambient/AmbientModelRequiredCard.tsx
 * 的 RN 对应物。AMBIENT 页有待摘要的转写窗口但一条时间线事件都没有时显示：
 * 引导下载端侧 LLM（i18n key 与 dev 一致：modelRequired.*）。dev 的按钮打开
 * AmbientModelSetupStep 底 sheet；RN 的模型面板在 Settings → Ambient 子页，
 * onOpenSetup 由上层导航过去。
 * Pressable 只管 onPress（本项目 Pressable style 不渲染 → 视觉全在内层 View）。
 */
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Cpu } from "lucide-react-native";

import { RECOMMENDED_AMBIENT_LLM_LABEL } from "../../ambient/models-recommendation";

// --foreground / --background 通道值（对齐 AmbientScreen；NativeWind 的
// hsl(var()) 无 alpha 槽 → 带透明度色一律内联 hsla，保证渲染）。
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "hsl(220, 30%, 96%)";

export default function AmbientModelRequiredCard({ onOpenSetup }: { onOpenSetup: () => void }) {
  const { t } = useTranslation("ambient");
  return (
    <View
      style={{
        marginTop: 20,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: fg(0.1),
        backgroundColor: fg(0.03),
        padding: 16,
      }}
    >
      <View className="flex-row items-start" style={{ gap: 12 }}>
        <View
          style={{
            marginTop: 2,
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: fg(),
          }}
        >
          <Cpu size={15} strokeWidth={2} color={BG} />
        </View>
        <View className="flex-1">
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, lineHeight: 16, color: fg(0.8) }}>
            {t("modelRequired.title")}
          </Text>
          <Text
            style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.5), marginTop: 4 }}
          >
            {t("modelRequired.body", { model: RECOMMENDED_AMBIENT_LLM_LABEL })}
          </Text>
          <Pressable
            onPress={onOpenSetup}
            accessibilityRole="button"
            style={{ marginTop: 12, alignSelf: "flex-start" }}
          >
            <View
              style={{
                minHeight: 36,
                borderRadius: 999,
                paddingHorizontal: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: fg(),
              }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: BG }}>
                {t("modelRequired.download", { model: RECOMMENDED_AMBIENT_LLM_LABEL })}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
