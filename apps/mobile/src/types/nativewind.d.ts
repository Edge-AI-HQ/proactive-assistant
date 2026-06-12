// NativeWind className props——直接内联声明（nativewind/types 与
// react-native-css-interop/types 的 triple-slash 链在本 monorepo 的
// hoisting + expo tsconfig（moduleResolution bundler）下解析不稳定，
// 内联是确定性方案；运行时由 babel jsxImportSource 处理，类型只需补
// prop 面）。
import "react-native";

declare module "react-native" {
  interface ViewProps {
    className?: string;
  }
  interface TextProps {
    className?: string;
  }
  interface ImagePropsBase {
    className?: string;
  }
  interface ScrollViewProps {
    className?: string;
    contentContainerClassName?: string;
  }
  interface TextInputProps {
    className?: string;
  }
  interface PressableProps {
    className?: string;
  }
  interface TouchableOpacityProps {
    className?: string;
  }
  interface FlatListProps<ItemT> {
    columnWrapperClassName?: string;
    ListHeaderComponentClassName?: string;
    ListFooterComponentClassName?: string;
  }
  interface SwitchProps {
    className?: string;
  }
  interface ActivityIndicatorProps {
    className?: string;
  }
  interface KeyboardAvoidingViewProps {
    className?: string;
  }
}
