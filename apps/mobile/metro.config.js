/**
 * Metro（monorepo + NativeWind）：expo/metro-config 自动处理 npm
 * workspaces（watchFolders 含 root、workspace symlink 包由
 * babel-preset-expo 转译——与 web 的 vite alias 源码直引同构）；
 * withNativeWind 接 tailwind 编译（global.css 为入口）。
 */
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

module.exports = withNativeWind(getDefaultConfig(__dirname), {
  input: "./global.css",
});
