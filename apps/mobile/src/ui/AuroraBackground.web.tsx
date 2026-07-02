import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";

export default function AuroraBackground({
  veilOpacity = 0.35,
  children,
}: {
  veilOpacity?: number;
  children?: ReactNode;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} pointerEvents="none">
      <Image
        source={require("../assets/bg-gradient.jpg")}
        style={[StyleSheet.absoluteFill, styles.baseImage]}
        resizeMode="cover"
      />
      <View style={[styles.spot, styles.spotOne]} />
      <View style={[styles.spot, styles.spotTwo]} />
      <View style={[styles.spot, styles.spotThree]} />
      {children}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${veilOpacity})` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { isolation: "isolate", overflow: "hidden" },
  baseImage: { width: "100%", height: "100%", opacity: 0.6 },
  spot: {
    position: "absolute",
    borderRadius: 9999,
    opacity: 0.34,
    mixBlendMode: "screen",
  },
  spotOne: {
    width: "80%",
    height: "58%",
    left: "-18%",
    top: "4%",
    backgroundColor: "hsl(280, 70%, 78%)",
  },
  spotTwo: {
    width: "74%",
    height: "52%",
    right: "-22%",
    top: "18%",
    backgroundColor: "hsl(210, 70%, 82%)",
  },
  spotThree: {
    width: "70%",
    height: "46%",
    left: "16%",
    bottom: "-12%",
    backgroundColor: "hsl(320, 65%, 80%)",
  },
});
