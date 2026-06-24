import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

const BAR_COUNT = 18;

export function Waveform({
  active,
  color = "rgba(29,33,48,0.45)",
  style,
}: {
  active: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const values = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.35))).current;

  useEffect(() => {
    if (!active) {
      values.forEach((v) => v.stopAnimation(() => v.setValue(0.35)));
      return;
    }

    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 380 + (index % 5) * 55,
            delay: (index % 4) * 45,
            useNativeDriver: false,
          }),
          Animated.timing(value, {
            toValue: 0.25,
            duration: 360 + (index % 3) * 70,
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, values]);

  return (
    <View style={[styles.wrap, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {values.map((value, index) => {
        const height = value.interpolate({
          inputRange: [0, 1],
          outputRange: [5, 22 - (index % 3) * 3],
        });
        return (
          <Animated.View
            key={index}
            style={[
              styles.bar,
              {
                height,
                backgroundColor: color,
                opacity: active ? value.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.85] }) : 0.35,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  bar: {
    width: 2.5,
    borderRadius: 999,
  },
});
