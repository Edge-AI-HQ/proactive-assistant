/**
 * Login —— dev `proactive-ai-frontend/src/components/auth/LoginPage.tsx` +
 * `LoginBackdrop.tsx` 的 RN 对应物（逐字对齐）：
 * - LoginBackdrop：白底 → bg-gradient.jpg @0.6 → aurora 静止色斑（native-power-save
 *   真源形态，复用 AuroraBackground）→ nebula 视频 0.5× 慢放、就绪后 700ms 淡入到
 *   0.75 → white/30 白罩（比壳 VideoBackdrop 的 white/70 通透，dev 注释：登录页只有
 *   一个按钮，让 nebula 明显）。
 * - 中央深色 Google 按钮（Google 四色 G 徽 / signingIn 转圈 + 文案）、OAuth 失败
 *   红色横幅、底部 Terms/Privacy 法律脚注（auth ns i18n，链接开外部浏览器）。
 * - 入场动画同 dev framer：按钮块 y12→0 + fade 600ms delay150、脚注 fade delay350，
 *   ease bezier(0.32,0.72,0,1)。
 * 平台差异（非阉割）：dev 的 initialOAuthError 抓 web redirect 回调错误；RN 的
 * native PKCE 流错误在 onSignIn promise reject 时到达 —— 同一语义（OAuth 失败），
 * 映射到同一条横幅。hover 态映射为按压态。underline-offset RN 不支持，仅下划线。
 */
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Trans, useTranslation } from "react-i18next";
import { VideoView, useVideoPlayer } from "expo-video";
import Svg, { Path } from "react-native-svg";
import { Loader2 } from "lucide-react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInUp,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import AuroraBackground from "../ui/AuroraBackground";

/** dev EASE = [0.32, 0.72, 0, 1]。 */
const EASE = Easing.bezier(0.32, 0.72, 0, 1);
/** token --foreground: 230 25% 15% / --background: 220 30% 96%。 */
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BACKGROUND = "hsl(220, 30%, 96%)";
const backgroundA = (a: number) => `hsla(220, 30%, 96%, ${a})`;

const videoSource = require("../assets/constellation-bg.mp4");

/** dev LoginBackdrop 的视频层：0.5× 慢放循环，loadeddata 后 700ms 淡入到 0.75。 */
function NebulaVideo() {
  const opacity = useSharedValue(0);
  const player = useVideoPlayer(videoSource, (p) => {
    p.loop = true;
    p.muted = true;
    p.playbackRate = 0.5; // dev: el.playbackRate = 0.5
    p.play();
  });

  useEffect(() => {
    // dev: onLoadedData → opacity 0 → 0.75，transition-opacity duration-700。
    const fadeIn = () => {
      opacity.value = withTiming(0.75, { duration: 700 });
    };
    // 竞态防线：本地 bundle 资源加载极快，listener 挂上前 player 可能已经
    // readyToPlay——那样 statusChange 不会再发，必须先查当前态（否则视频
    // 永远停在 opacity 0，背景只剩静态渐变图）。
    if (player.status === "readyToPlay") fadeIn();
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") fadeIn();
    });
    return () => sub.remove();
  }, [player, opacity]);

  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, fade]}>
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** dev LoginPage signingIn 的 Loader2 animate-spin（1s linear）。 */
function SpinningLoader() {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={18} color={backgroundA(0.7)} strokeWidth={2} />
    </Animated.View>
  );
}

export default function LoginScreen({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const { t } = useTranslation("auth");
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleGoogle = async () => {
    if (signingIn) return;
    setAuthError(null);
    setSigningIn(true);
    try {
      await onSignIn();
      // resolve ≠ 必然登录成功（用户取消系统面板也正常返回）：复位按钮。
      // 真成功时 onAuthStateChange 翻转、本屏整体卸载，这里的复位无感。
      setSigningIn(false);
    } catch (err) {
      // OAuth provider 错误 / 回调缺 code / code exchange 失败（useAuth 抛出）——
      // 与 dev web initialOAuthError 同一错误类，进同一条横幅。
      console.error("[auth] Google sign-in failed:", err);
      setAuthError(err instanceof Error ? err.message : String(err));
      setSigningIn(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* dev LoginBackdrop：白底 + aurora（静止）+ 视频 + white/30。 */}
      <View style={[StyleSheet.absoluteFill, styles.whiteBase]} />
      <AuroraBackground veilOpacity={0.3}>
        <NebulaVideo />
      </AuroraBackground>

      <View style={styles.content}>
        <Animated.View
          entering={FadeInUp.duration(600)
            .delay(150)
            .easing(EASE)
            .withInitialValues({ opacity: 0, transform: [{ translateY: 12 }] })}
          style={styles.buttonBlock}
        >
          {authError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>Couldn't sign you in. {authError}</Text>
            </View>
          ) : null}
          {/* ⚠️ NativeWind 吞 Pressable 的 style → children-as-function + 内层
              View 承载全部样式（本仓 Pressable 惯例，SettingScreen BackButton 同款）。 */}
          <Pressable onPress={handleGoogle} disabled={signingIn} accessibilityRole="button">
            {({ pressed }) => (
              <View style={[styles.googleButton, pressed && styles.googleButtonPressed]}>
                {signingIn ? (
                  <>
                    <SpinningLoader />
                    <Text style={[styles.googleText, styles.googleTextSigning]}>
                      {t("login.signingIn")}
                    </Text>
                  </>
                ) : (
                  <>
                    <GoogleG />
                    <Text style={styles.googleText}>Continue with Google</Text>
                  </>
                )}
              </View>
            )}
          </Pressable>
        </Animated.View>

        <Animated.View entering={FadeIn.duration(600).delay(350).easing(EASE)}>
          <Text style={styles.legal}>
            <Trans
              t={t}
              i18nKey="legal.agreement"
              components={{
                terms: (
                  <Text
                    style={styles.legalLink}
                    onPress={() => void Linking.openURL("https://www.pinai.io/terms")}
                  />
                ),
                privacy: (
                  <Text
                    style={styles.legalLink}
                    onPress={() => void Linking.openURL("https://www.pinai.io/privacy")}
                  />
                ),
              }}
            />
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

/** dev LoginPage 内联 Google 四色 G（path/viewBox 逐字同源），18×18。 */
function GoogleG() {
  return (
    <Svg viewBox="0 0 48 48" width={18} height={18}>
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  whiteBase: { backgroundColor: "#ffffff" },
  // dev: relative z-10 flex h-full flex-col items-center justify-center px-6
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  buttonBlock: { width: "100%", maxWidth: 360 },
  // dev: mb-4 rounded-2xl border-red-500/20 bg-red-500/10 px-4 py-3 text-center
  errorBanner: {
    marginBottom: 16,
    borderRadius: 16, // rounded-2xl（Tailwind 默认，radius token 只覆盖 lg/md/sm）
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
    backgroundColor: "rgba(239,68,68,0.1)",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  // dev: Text bodySm text-red-600
  errorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    color: "#dc2626",
    textAlign: "center",
  },
  // dev: w-full gap-3 rounded-2xl bg-foreground px-5 py-3.5 + 0 8px 32px black/18
  googleButton: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    borderRadius: 16,
    backgroundColor: fg(),
    paddingHorizontal: 20,
    paddingVertical: 14,
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
  },
  googleButtonPressed: { backgroundColor: fg(0.85) }, // hover:bg-foreground/85 的按压对应
  // dev: Text variant body(15) weight medium, text-background
  googleText: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
    lineHeight: 22,
    color: BACKGROUND,
  },
  googleTextSigning: { color: backgroundA(0.8) }, // signingIn: text-background/80
  // dev: mt-7 text-center text-caption(11) leading-relaxed text-foreground/40
  legal: {
    marginTop: 28,
    textAlign: "center",
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 18, // leading-relaxed ≈ 1.625
    color: fg(0.4),
  },
  legalLink: { textDecorationLine: "underline" },
});
