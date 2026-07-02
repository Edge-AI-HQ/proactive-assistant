import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp, Shield, ShieldOff } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useUserSettings, type PermissionMode } from "@pin-ai/state";

const FG = "29,33,48";
const DESTRUCTIVE = "hsl(0, 72%, 60%)";
const MODES: readonly PermissionMode[] = ["ask", "bypass"];

export default function PermissionModeMenu() {
  const { t } = useTranslation("chat");
  const { settings, saving, error: settingsError, patch } = useUserSettings();
  const mode = settings?.permissionMode ?? "ask";
  const [open, setOpen] = useState(false);
  const [pendingBypass, setPendingBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bypassed = mode === "bypass";

  const apply = async (next: PermissionMode) => {
    setError(null);
    const result = await patch({ permissionMode: next });
    if (!result) setError(settingsError ?? t("composer.permission.saveFailed"));
  };

  const select = (next: PermissionMode) => {
    setOpen(false);
    if (next === mode) return;
    if (next === "bypass") {
      setPendingBypass(true);
      return;
    }
    void apply(next);
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel={t(`composer.permission.${mode}`)}
        accessibilityState={{ expanded: open, disabled: saving }}
        style={styles.trigger}
      >
        <View style={[styles.triggerInner, open && styles.triggerActive, saving && styles.dim]}>
          {bypassed ? (
            <ShieldOff size={13} color={DESTRUCTIVE} strokeWidth={2} />
          ) : (
            <Shield size={13} color={`rgba(${FG},0.4)`} strokeWidth={2} />
          )}
          <Text style={[styles.triggerText, bypassed && styles.dangerText]}>{t(`composer.permission.${mode}`)}</Text>
          {open ? (
            <ChevronUp size={12} color={`rgba(${FG},0.4)`} strokeWidth={2} />
          ) : (
            <ChevronDown size={12} color={`rgba(${FG},0.4)`} strokeWidth={2} />
          )}
        </View>
      </Pressable>

      {/* Tap anywhere outside → close the menu. Web closes on document
          click-outside; RN has no such listener, so a full-screen transparent
          Pressable sits behind the menu (below it, above everything else) and
          catches the tap. Only mounted while open. */}
      {open ? (
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close menu"
          accessibilityRole="button"
        />
      ) : null}

      {open ? (
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>{t("composer.permission.menuTitle")}</Text>
          {MODES.map((item) => {
            const active = item === mode;
            const danger = item === "bypass";
            return (
              <Pressable
                key={item}
                onPress={() => select(item)}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
              >
                <View style={styles.menuItemInner}>
                  <View style={styles.checkSlot}>
                    {active ? <Check size={14} color={`rgba(${FG},0.7)`} strokeWidth={2.5} /> : null}
                  </View>
                  <Text style={[styles.menuLabel, danger && styles.dangerText]}>{t(`composer.permission.${item}`)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {pendingBypass ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>{t("composer.permission.confirmBody")}</Text>
          <View style={styles.confirmActions}>
            <Pressable onPress={() => setPendingBypass(false)} style={styles.confirmGhost}>
              <Text style={styles.confirmGhostText}>{t("composer.permission.cancel")}</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => {
                setPendingBypass(false);
                void apply("bypass");
              }}
              style={[styles.confirmDanger, saving && styles.dim]}
            >
              <Text style={styles.confirmDangerText}>{t("composer.permission.confirm")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative", paddingHorizontal: 8, paddingTop: 6, alignItems: "flex-start" },
  // NativeWind swallows Pressable's own `style` in this project (#216) → the
  // visual button (padding / radius / grey bg) must live on the inner View.
  trigger: { alignSelf: "flex-start" },
  triggerInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 22,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
  },
  // Web's hover:bg-foreground/[0.06] has no touch equivalent → map it to the
  // menu-open state: the trigger stays grey while its menu is showing, and
  // clears when the menu closes (incl. tapping away once outside-close lands).
  triggerActive: { backgroundColor: `rgba(${FG},0.06)` },
  triggerText: { fontSize: 12, lineHeight: 16, color: `rgba(${FG},0.55)`, fontFamily: "Geist_400Regular" },
  dangerText: { color: DESTRUCTIVE },
  dim: { opacity: 0.45 },
  // Full-screen tap-catcher behind the open menu. Negative insets escape the
  // small `wrap` to blanket the screen; transparent (no scrim, matches web);
  // zIndex 10 keeps it under the menu (20) but over the rest of the UI.
  backdrop: { position: "absolute", top: -1000, left: -1000, right: -1000, bottom: -1000, zIndex: 10 },
  menu: {
    position: "absolute",
    left: 8,
    bottom: 30,
    minWidth: 200,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    backgroundColor: "#f2f4f8",
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
    zIndex: 20,
  },
  menuTitle: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    fontSize: 12,
    lineHeight: 16,
    color: `rgba(${FG},0.4)`,
    fontFamily: "Geist_400Regular",
  },
  menuItem: {},
  menuItemInner: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 12 },
  menuItemPressed: { backgroundColor: `rgba(${FG},0.06)` },
  checkSlot: { width: 16, alignItems: "center" },
  menuLabel: { fontSize: 12, lineHeight: 16, color: `rgba(${FG},0.8)`, fontFamily: "Geist_400Regular" },
  confirm: {
    marginTop: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "hsla(0, 72%, 60%, 0.3)",
    backgroundColor: "hsla(0, 72%, 60%, 0.06)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignSelf: "stretch",
  },
  confirmText: { fontSize: 12, lineHeight: 20, color: `rgba(${FG},0.7)`, fontFamily: "Geist_400Regular" },
  confirmActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  confirmGhost: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  confirmGhostText: { fontSize: 12, color: `rgba(${FG},0.55)`, fontFamily: "Geist_400Regular" },
  confirmDanger: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: DESTRUCTIVE },
  confirmDangerText: { fontSize: 12, color: "#fff", fontFamily: "Geist_500Medium" },
  error: { marginTop: 4, paddingHorizontal: 4, fontSize: 12, color: DESTRUCTIVE, fontFamily: "Geist_500Medium" },
});
