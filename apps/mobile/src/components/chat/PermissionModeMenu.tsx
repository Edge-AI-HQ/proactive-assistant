import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, Shield, ShieldOff } from "lucide-react-native";
import { useUserSettings, type PermissionMode } from "@pin-ai/state";

const FG = "29,33,48";
const DESTRUCTIVE = "#dc2626";
const MODES: readonly PermissionMode[] = ["ask", "bypass"];

const LABELS: Record<PermissionMode, string> = {
  ask: "Ask Permissions",
  bypass: "Bypass Permissions",
};

export default function PermissionModeMenu() {
  const { settings, saving, error: settingsError, patch } = useUserSettings();
  const mode = settings?.permissionMode ?? "ask";
  const [open, setOpen] = useState(false);
  const [pendingBypass, setPendingBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bypassed = mode === "bypass";

  const apply = async (next: PermissionMode) => {
    setError(null);
    const result = await patch({ permissionMode: next });
    if (!result) setError(settingsError ?? "Failed to save permission mode");
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
        accessibilityLabel={LABELS[mode]}
        accessibilityState={{ expanded: open, disabled: saving }}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed, saving && styles.dim]}
      >
        {bypassed ? (
          <ShieldOff size={12} color={DESTRUCTIVE} strokeWidth={2} />
        ) : (
          <Shield size={12} color={`rgba(${FG},0.48)`} strokeWidth={2} />
        )}
        <Text style={[styles.triggerText, bypassed && styles.dangerText]}>{LABELS[mode]}</Text>
        <ChevronDown
          size={13}
          color={`rgba(${FG},0.5)`}
          strokeWidth={2}
        />
      </Pressable>

      {open ? (
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>Permission mode</Text>
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
                <View style={styles.checkSlot}>
                  {active ? <Check size={15} color={`rgba(${FG},0.72)`} strokeWidth={2.5} /> : null}
                </View>
                <Text style={[styles.menuLabel, danger && styles.dangerText]}>{LABELS[item]}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {pendingBypass ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>
            Bypass Permissions lets the agent run side-effect actions without asking each time.
          </Text>
          <View style={styles.confirmActions}>
            <Pressable onPress={() => setPendingBypass(false)} style={styles.confirmGhost}>
              <Text style={styles.confirmGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => {
                setPendingBypass(false);
                void apply("bypass");
              }}
              style={[styles.confirmDanger, saving && styles.dim]}
            >
              <Text style={styles.confirmDangerText}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative", paddingHorizontal: 8, paddingTop: 8, alignItems: "flex-start" },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 22,
    borderRadius: 8,
    paddingHorizontal: 4,
  },
  triggerPressed: { backgroundColor: `rgba(${FG},0.06)` },
  triggerText: { fontSize: 12, lineHeight: 16, color: `rgba(${FG},0.58)`, fontFamily: "Inter_400Regular" },
  dangerText: { color: DESTRUCTIVE },
  dim: { opacity: 0.45 },
  menu: {
    position: "absolute",
    left: 8,
    bottom: 30,
    minWidth: 210,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    backgroundColor: "#f8f8fb",
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
    zIndex: 20,
  },
  menuTitle: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    fontSize: 12,
    color: `rgba(${FG},0.4)`,
    fontFamily: "Inter_600SemiBold",
  },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  menuItemPressed: { backgroundColor: `rgba(${FG},0.06)` },
  checkSlot: { width: 18, alignItems: "center" },
  menuLabel: { fontSize: 14, color: `rgba(${FG},0.82)`, fontFamily: "Inter_500Medium" },
  confirm: {
    marginTop: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(220,38,38,0.28)",
    backgroundColor: "rgba(220,38,38,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxWidth: 330,
  },
  confirmText: { fontSize: 12, lineHeight: 17, color: `rgba(${FG},0.7)`, fontFamily: "Inter_500Medium" },
  confirmActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  confirmGhost: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  confirmGhostText: { fontSize: 12, color: `rgba(${FG},0.58)`, fontFamily: "Inter_600SemiBold" },
  confirmDanger: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: DESTRUCTIVE },
  confirmDangerText: { fontSize: 12, color: "#fff", fontFamily: "Inter_700Bold" },
  error: { marginTop: 4, paddingHorizontal: 4, fontSize: 12, color: DESTRUCTIVE, fontFamily: "Inter_500Medium" },
});
