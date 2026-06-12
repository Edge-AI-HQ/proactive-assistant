module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // reanimated 必须是最后一个 plugin（官方要求）。
    plugins: ["react-native-reanimated/plugin"],
  };
};
