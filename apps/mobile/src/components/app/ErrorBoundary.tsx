/**
 * RN 全局 Error Boundary —— dev `proactive-ai-frontend/src/components/app/ErrorBoundary.tsx`
 * 的 RN 对应物。捕获组件树里未处理的渲染异常，渲染可恢复的 fallback（Try again），
 * 而不是让整个 App 白屏 / 闪退。dev 明确注释此为 iOS 真机 React #185 无限渲染崩溃硬化过；
 * RN 此前裸奔（release 一旦 render 抛错即白屏）。
 *
 * Error boundary 只能是 class component（React 无 hook 等价），是本项目「组件用函数式」
 * 的唯一合法例外，与 dev 同。文案走 `common:errorBoundary.*`（与 dev 同 key，已存在于
 * 12 namespace）；error.message 原样渲染（豁免 i18n）。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import i18n from "../../i18n";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BG = "#f2f4f8"; // token --background: 220 30% 96%（= App.tsx safe 背景）

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      // class component（error boundary 不能用 hook）→ 直接 i18n.t；错误态是瞬时的，
      // 不需要对语言切换保持响应。Pressable 的 style 本项目不渲染 → 视觉全在内层 View。
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: BG }}>
          <View style={{ width: "100%", maxWidth: 360, alignItems: "center", gap: 16 }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 18, lineHeight: 24, color: fg() }}>
              {i18n.t("common:errorBoundary.title")}
            </Text>
            <Text
              style={{ fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 20, color: fg(0.6), textAlign: "center" }}
            >
              {this.state.error?.message ?? i18n.t("common:errorBoundary.fallbackMessage")}
            </Text>
            <Pressable onPress={this.handleReset} accessibilityRole="button" hitSlop={8}>
              <View style={{ borderRadius: 12, backgroundColor: fg(), paddingHorizontal: 24, paddingVertical: 10 }}>
                <Text style={{ fontFamily: "Inter_500Medium", fontSize: 14, lineHeight: 20, color: BG }}>
                  {i18n.t("common:errorBoundary.tryAgain")}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}
