/// <reference types="nativewind/types" />
/// <reference types="react-native-css-interop/types" />

// global.css 是 NativeWind 的编译入口（metro withNativeWind 消费），
// TS 侧只需 side-effect 声明。
// 注：css-interop 的 reference 显式列出——monorepo hoisting 下嵌套
// triple-slash 解析不可靠（nativewind/types 只含一行转发）。
declare module "*.css";
