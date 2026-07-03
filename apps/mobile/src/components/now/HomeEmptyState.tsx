/**
 * NOW 空态引导——web `components/now/HomeEmptyState.tsx` 的 RN 介质版，
 * feed 零卡时渲染在球面区域。两态（web 同注释）：
 *   A. 设置未完成 → 只列「还缺的」步骤 checklist（voice 优先、connect 次之，
 *      各行满足即自隐），下方一条 "Review permissions" 链接。
 *   B. 设置完成但 feed 仍空 → 冷静的 "warming up" 文案（卡片生成是异步的，
 *      分钟~小时级）。
 * RN 恒为 native，voiceState 不会是 "unsupported"（web-only 分支），但显隐
 * 判断照 web 逐字保留。
 */
import { Pressable, Text, View } from "react-native";
import { ChevronRight, Mic, Plug, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";

/** web hooks/useVoicePermission 的状态契约（RN 读 AmbientAudio 权限映射到同三态）。 */
export type VoicePermissionState = "granted" | "missing" | "unsupported";

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)

interface HomeEmptyStateProps {
  /** ACTIVE Composio 连接数。0 → 显示 "Connect" 行。 */
  connectorCount: number;
  /** 连接列表已加载才把 0 当「没连接」（避免加载前空数组误 nag 已连接用户）。 */
  connectorsKnown: boolean;
  /** OS 麦克风权限。"missing" → 显示 "Turn on voice" 行。 */
  voiceState: VoicePermissionState;
  /** 就地请求麦克风；拒绝时父级兜底跳权限面板。 */
  onEnableVoice: () => void;
  /** 打开 Connect 页。 */
  onConnect: () => void;
  /** 打开完整 Ambient 权限面板（web: Account → Ambient）。 */
  onReviewPermissions: () => void;
}

function ChecklistRow({
  icon: Icon,
  title,
  subtitle,
  onPress,
  divider,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  onPress: () => void;
  divider: boolean;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      {/* web: divide-y divide-foreground/[0.06]——RN 用行顶边替代 */}
      <View
        className="flex-row items-center gap-3 px-3 py-3"
        style={divider ? { borderTopWidth: 1, borderTopColor: `rgba(${FG},0.06)` } : null}
      >
        <View className="h-9 w-9 items-center justify-center rounded-full bg-foreground/[0.06]">
          <Icon size={16} strokeWidth={2} color={`rgba(${FG},0.7)`} />
        </View>
        <View className="flex-1">
          <Text className="text-[13px] text-foreground" style={{ fontFamily: "Inter_600SemiBold", lineHeight: 16 }}>
            {title}
          </Text>
          <Text
            numberOfLines={1}
            className="mt-0.5 text-[12px] text-foreground/50"
            style={{ fontFamily: "Inter_400Regular", lineHeight: 16 }}
          >
            {subtitle}
          </Text>
        </View>
        <ChevronRight size={16} color={`rgba(${FG},0.3)`} />
      </View>
    </Pressable>
  );
}

export default function HomeEmptyState({
  connectorCount,
  connectorsKnown,
  voiceState,
  onEnableVoice,
  onConnect,
  onReviewPermissions,
}: HomeEmptyStateProps) {
  const { t } = useTranslation("card");
  const needVoice = voiceState === "missing";
  const needConnect = connectorsKnown && connectorCount === 0;
  // web 同注释：权限面板只在有 native ambient 传感器的端有意义；web
  // ("unsupported") 上隐藏。RN 恒 native，条件照抄保语义。
  const showPermissionsLink = voiceState !== "unsupported";

  if (!needVoice && !needConnect) {
    return (
      <View className="flex-1 items-center justify-center px-8 pb-40">
        <Text className="text-[15px] text-foreground/80" style={{ fontFamily: "Inter_600SemiBold" }}>
          {t("emptyState.warmingUpTitle")}
        </Text>
        <Text
          className="mt-1.5 max-w-[288px] text-center text-[13px] leading-5 text-foreground/50"
          style={{ fontFamily: "Inter_400Regular" }}
        >
          {t("emptyState.warmingUpBody")}
        </Text>
      </View>
    );
  }

  return (
    <View className="px-5 pt-3">
      <Text className="mb-2.5 text-[13px] text-foreground/55" style={{ fontFamily: "Inter_500Medium" }}>
        {t("emptyState.checklistTitle")}
      </Text>
      {/* web: rounded-2xl border-foreground/[0.06] bg-foreground/[0.04] shadow-sm */}
      <View className="overflow-hidden rounded-2xl border border-foreground/[0.06] bg-foreground/[0.04]">
        {needVoice ? (
          <ChecklistRow
            icon={Mic}
            title={t("emptyState.voiceTitle")}
            subtitle={t("emptyState.voiceSubtitle")}
            onPress={onEnableVoice}
            divider={false}
          />
        ) : null}
        {needConnect ? (
          <ChecklistRow
            icon={Plug}
            title={t("emptyState.connectTitle")}
            subtitle={t("emptyState.connectSubtitle")}
            onPress={onConnect}
            divider={needVoice}
          />
        ) : null}
      </View>
      {showPermissionsLink ? (
        <Pressable onPress={onReviewPermissions} accessibilityRole="button" hitSlop={8}>
          {/* web 常态无下划线（underline 只在 hover）；RN 无 hover → 不加。 */}
          <Text className="mt-3 px-1 text-[12px] text-foreground/45" style={{ fontFamily: "Inter_400Regular" }}>
            {t("emptyState.reviewPermissions")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
