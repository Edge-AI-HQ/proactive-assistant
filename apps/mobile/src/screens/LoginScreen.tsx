import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

export default function LoginScreen({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.root}>
      <Text style={styles.logo}>PIN AI</Text>
      <Text className="mt-2 mb-12 text-[15px] text-muted-foreground font-sans" style={styles.taglineSpacing}>Your proactive personal agent</Text>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          onSignIn()
            .catch((err) => console.error("[auth] sign-in failed:", err))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Continue with Google</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f6f4f0",
    padding: 32,
  },
  logo: { fontSize: 34, fontWeight: "700", color: "#1a1a1a", letterSpacing: 1 },
  taglineSpacing: { marginBottom: 48 },
  button: {
    backgroundColor: "#1a1a1a",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
    minWidth: 260,
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
