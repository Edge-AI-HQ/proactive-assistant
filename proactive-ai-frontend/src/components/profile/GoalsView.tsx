/**
 * frontend GoalsView shim —— 实现已下沉 @pin-ai/ui-web。
 *
 * frontend 是手机场景(AppLayout 是 max-w-md 居中手机列),即使桌面 web 下 viewport
 * 宽,goal 详情也应是「与背景列同宽的底部抽屉」而非 zebra 桌面的居中 popup。故强制
 * detailLayout="drawer"(apps/web 直接用 @pin-ai/ui-web 的 GoalsView,保持 auto:
 * 宽屏 popup)。
 */
import type { ComponentProps } from "react";
import { GoalsView } from "@pin-ai/ui-web";

export default function GoalsViewShim(props: ComponentProps<typeof GoalsView>) {
  return <GoalsView {...props} detailLayout="drawer" />;
}
