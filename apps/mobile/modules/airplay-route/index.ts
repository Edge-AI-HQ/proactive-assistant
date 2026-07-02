/**
 * airplay-route (Expo 本地 view 模块) JS 绑定：iOS 系统 AirPlay 路由选择器
 * （AVRoutePickerView）。渲染官方 AirPlay 字形按钮,点击弹出系统路由选择器
 * （和 dev proactive-ai-frontend 的 <audio controls> 投屏按钮同一系统控件）。
 * 位置由 iOS 托管(从屏幕底部升起的 sheet)——App 无法改,这是系统模态。
 * 白色 tint 在原生侧固定(见 ios/AirplayRouteModule.swift),契合播放条的白色前景。
 */
import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export const AirplayRouteButton = requireNativeViewManager<ViewProps>("AirplayRoute");
