/**
 * 围栏代码块——web ui-web/chat/conversation/CodeBlock 的 RN 介质版:header
 * (语言标签 + Copy/Copied 按钮)+ 等宽正文,长行横向滚动(web overflow-x-auto)。
 * web 正文经 rehype-highlight 语法高亮;RN 无成熟高亮库,正文保持纯等宽文本
 * (高亮本体跳过,与迁移清单对齐)。
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";

const FG = "29,33,48";

export default function CodeBlock({
  language,
  content,
}: {
  language: string | null;
  content: string;
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(content);
      setCopied(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <Text style={styles.language}>{language ?? "text"}</Text>
        <Pressable onPress={() => void copy()} accessibilityRole="button" hitSlop={6}>
          <View style={styles.copyBtn}>
            {copied ? (
              <Check size={11} strokeWidth={2} color="#10b981" />
            ) : (
              <Copy size={11} strokeWidth={1.8} color={`rgba(${FG},0.5)`} />
            )}
            <Text style={styles.copyText}>
              {copied ? t("codeBlock.copied") : t("codeBlock.copy")}
            </Text>
          </View>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bodyScroll}>
        <Text style={styles.code}>{content}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // web: my-2 rounded-lg border border-foreground/10 bg-foreground/[0.04]。
  block: {
    marginVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.1)`,
    backgroundColor: `rgba(${FG},0.04)`,
    overflow: "hidden",
  },
  // web: px-3 py-1 border-b border-foreground/10 bg-foreground/[0.03]。
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: `rgba(${FG},0.1)`,
    backgroundColor: `rgba(${FG},0.03)`,
  },
  // web: text-caption(11) font-mono text-foreground/50。
  language: { fontSize: 11, fontFamily: "Menlo", color: `rgba(${FG},0.5)` },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  copyText: { fontSize: 11, color: `rgba(${FG},0.5)`, fontFamily: "Geist_400Regular" },
  bodyScroll: { maxWidth: "100%" },
  // web: px-3 py-2 text-label(12) leading-relaxed font-mono。
  code: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    lineHeight: 19,
    fontFamily: "Menlo",
    color: `rgba(${FG},0.85)`,
  },
});
