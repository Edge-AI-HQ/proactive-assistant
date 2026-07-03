/**
 * Metro（monorepo + NativeWind）：expo/metro-config 自动处理 npm
 * workspaces（watchFolders 含 root、workspace symlink 包由
 * babel-preset-expo 转译——与 web 的 vite alias 源码直引同构）；
 * withNativeWind 接 tailwind 编译（global.css 为入口）。
 */
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const config = withNativeWind(getDefaultConfig(__dirname), {
  input: "./global.css",
});

// 单一 react-native 守卫。iOS Pods 按嵌套的 apps/mobile/node_modules/react-native
// 编译（0.85.3 = 本 app 钉死的版本）；Expo SDK 传递依赖会在 repo 根另拉一份
// react-native（0.86.0）进 JS bundle → 运行时报 version mismatch（JS 0.86.0 vs
// native 0.85.3）。把所有 react-native 导入重定向到嵌套那份，让 bundle 与已编译
// 的原生一致。npm dedupe 治不了（peer 依赖各自解析），故在 Metro 层收口。
const NESTED_RN = path.resolve(__dirname, "node_modules/react-native");
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native" || moduleName.startsWith("react-native/")) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(NESTED_RN, "index.js") },
      moduleName,
      platform,
    );
  }
  return (baseResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
