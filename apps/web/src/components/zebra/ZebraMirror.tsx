import { GoalsView } from "@pin-ai/ui-web";
import type { ComposioState } from "@pin-ai/state";

/**
 * Desktop (zebra) MIRROR — production GoalsView（profile / goals / memory /
 * skills 全功能）装进 zebra 阅读列。Profile&Memory 并排的桌面重排（zebra
 * 原型）属视觉迭代轮，功能先行。
 */
export default function ZebraMirror({ composio }: { composio: ComposioState }) {
  return (
    <div className="h-full w-full max-w-2xl mx-auto overflow-hidden">
      <GoalsView composio={composio} />
    </div>
  );
}
