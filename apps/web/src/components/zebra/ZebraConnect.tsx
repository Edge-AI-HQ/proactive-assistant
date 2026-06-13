import { ControlPanel } from "@pin-ai/ui-web";
import type { ComposioState } from "@pin-ai/state";

/**
 * Desktop (zebra) CONNECT — production ControlPanel（Composio 连接矩阵 +
 * 自定义 MCP + device registry + 上传数据 timeline）装进 zebra 阅读列。
 * 桌面网格重排（zebra 原型的 tiered grid）属视觉迭代轮，功能先行。
 */
export default function ZebraConnect({ composio }: { composio: ComposioState }) {
  return (
    <div className="h-full w-full max-w-2xl mx-auto overflow-hidden">
      <ControlPanel composio={composio} />
    </div>
  );
}
