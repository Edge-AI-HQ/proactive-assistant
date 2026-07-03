/**
 * `[connect:<slug>]` 内联 chip——web ui-web/connect/ConnectChip 的 RN 介质版:
 * assistant 正文里的字面 tag 换成小胶囊,点击直接发起 Composio OAuth
 * (components/connect/connect-oauth 的 connect→wait→close 链路,dev 同款
 * settings 页流程)。未知 slug 回退为字面文本,LLM 打错 slug 不破坏消息渲染。
 * tag→chip 的替换在 MarkdownText 的 text rule;本组件只渲一个 chip。
 * 介质注:chip 是 Text 内嵌 View(RN inline view),行高随 chip 略撑属预期。
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { resolveToolkit } from "@pin-ai/core";
import { useComposio } from "@pin-ai/state";

import { Spinner } from "../../ui/Spinner";
import { getToolkitIcon } from "../../lib/toolkit-icons";
import { triggerConnectorOAuth } from "../connect/connect-oauth";

const FG = "29,33,48";

export function ConnectChip({ toolkit }: { toolkit: string }) {
  // 每个 chip 自带一份 useComposio(mount 时各一次 status + connections GET)。
  // LLM 每 turn 至多一个 nudge,可接受——dev 同款取舍(见 web ConnectChip 注)。
  const { t } = useTranslation("connect");
  const composio = useComposio();
  const [busy, setBusy] = useState(false);
  const meta = resolveToolkit(toolkit);

  // Unknown slug → degrade to literal text(dev 同款防线)。
  if (!meta) {
    return <Text>[connect:{toolkit}]</Text>;
  }

  const alreadyConnected = composio.isToolkitConnected(meta.canonicalSlug);
  const Icon = getToolkitIcon(meta.canonicalSlug);
  const disabled = busy || alreadyConnected;

  const handlePress = async () => {
    if (disabled) return;
    setBusy(true);
    try {
      await triggerConnectorOAuth(meta.canonicalSlug, composio);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => void handlePress()}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={
        alreadyConnected
          ? t("connectChip.alreadyConnected", { name: meta.label })
          : t("connectChip.connect", { name: meta.label })
      }
    >
      <View style={[styles.chip, disabled && styles.chipDisabled]}>
        {busy ? (
          <Spinner size={11} color={`rgba(${FG},0.7)`} />
        ) : Icon ? (
          <Icon size={11} strokeWidth={2} color={`rgba(${FG},0.7)`} />
        ) : null}
        <Text style={styles.label}>
          {alreadyConnected
            ? t("connectChip.connected", { name: meta.label })
            : t("connectChip.connect", { name: meta.label })}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // web: inline-flex gap-1 px-2 py-0.5 mx-0.5 rounded-full text-label(12)
  //      border border-foreground/15 bg-foreground/[0.04]。
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginHorizontal: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.15)`,
    backgroundColor: `rgba(${FG},0.04)`,
  },
  chipDisabled: { opacity: 0.5 },
  label: { fontSize: 12, lineHeight: 14, color: `rgba(${FG},0.85)`, fontFamily: "Geist_500Medium" },
});
