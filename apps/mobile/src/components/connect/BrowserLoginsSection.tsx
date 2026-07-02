/**
 * "Website logins"——web `ui-web/connect/BrowserLoginsSection.tsx` 的 RN 介质版：
 * agent 浏览器里登录过的网站列表 + 删除（cookie 清理在后端）。数据复用
 * @pin-ai/state useBrowserLogins。无登录时渲染空（同 web）。
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Globe2, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useBrowserLogins } from "@pin-ai/state";

import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;

export function BrowserLoginsSection() {
  const { t } = useTranslation("connect");
  const { logins, isLoading, deleteLogin, deletingDomain } = useBrowserLogins();

  if (!isLoading && logins.length === 0) return null;

  return (
    <GlassCard style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconBox}>
          <Globe2 size={16} strokeWidth={1.5} color={fg(0.6)} />
        </View>
        <View style={styles.flex1MinW0}>
          <Text style={styles.title}>{t("browserLogins.title")}</Text>
          <Text style={styles.subtitle}>{t("browserLogins.subtitle")}</Text>
        </View>
      </View>

      <View style={styles.list}>
        {isLoading && logins.length === 0 ? (
          <View style={styles.loadingRow}>
            <Spinner size={13} color={fg(0.45)} />
            <Text style={styles.loadingText}>{t("browserLogins.loading")}</Text>
          </View>
        ) : (
          logins.map((login) => {
            const isDeleting = deletingDomain === login.siteDomain;
            const label = login.loginLabel || login.displayName;
            return (
              <View key={login.siteDomain} style={styles.loginRow}>
                <View style={styles.loginIconSlot}>
                  <Globe2 size={14} strokeWidth={1.5} color={fg(0.35)} />
                </View>
                <View style={styles.flex1MinW0}>
                  <View style={styles.rowGap6}>
                    <Text style={styles.domain} numberOfLines={1}>
                      {login.siteDomain}
                    </Text>
                    {login.status === "expired" ? (
                      <Text style={styles.expired}>{t("browserLogins.needsRelogin")}</Text>
                    ) : null}
                  </View>
                  {label ? (
                    <Text style={styles.label} numberOfLines={1}>
                      {label}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => void deleteLogin(login.siteDomain)}
                  disabled={isDeleting}
                  accessibilityRole="button"
                  accessibilityLabel={t("browserLogins.removeAria", { domain: login.siteDomain })}
                >
                  <View style={[styles.deleteBtn, isDeleting && { opacity: 0.5 }]}>
                    {isDeleting ? (
                      <Spinner size={12} color={fg(0.35)} />
                    ) : (
                      <Trash2 size={12} color={fg(0.35)} />
                    )}
                  </View>
                </Pressable>
              </View>
            );
          })
        )}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  flex1MinW0: { flex: 1, minWidth: 0 },
  rowGap6: { flexDirection: "row", alignItems: "center", gap: 6 },
  card: { marginTop: 12, padding: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: fg(0.06),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  subtitle: { marginTop: 2, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.45) },
  list: { marginTop: 12, gap: 4 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingVertical: 8 },
  loadingText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.45) },
  loginRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    backgroundColor: fg(0.02),
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  loginIconSlot: { width: 20, height: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  domain: { flexShrink: 1, fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: fg(0.8) },
  expired: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: "#d97706" },
  label: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.35) },
  deleteBtn: { borderRadius: 20, padding: 4 },
});
