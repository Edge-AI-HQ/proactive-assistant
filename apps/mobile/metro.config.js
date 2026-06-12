/**
 * Metro（monorepo）：expo/metro-config 自动处理 npm workspaces——
 * watchFolders 含 repo root、workspace symlink 包（@pin-ai/core|state，
 * exports 指 src/index.ts 纯 TS 源码）由 babel-preset-expo 直接转译，
 * 与 web 的 vite alias 源码直引同构（分层方案 §3.2：内部包不打包）。
 */
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
