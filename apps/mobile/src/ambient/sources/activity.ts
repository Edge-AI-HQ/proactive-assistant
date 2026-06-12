/**
 * Activity 源（Swift 保留件：CMMotionActivity 经 ambient-visit Expo
 * module）。变化驱动：类型切换时推一条（与 web sources/activity.ts 的
 * 去重语义一致——连续同类型不重复推）。
 */
import { AmbientVisit, type ActivityEvent } from "../../../modules/ambient-visit";
import { SIGNAL_KINDS, type AmbientSource, type SourceContext } from "../types";

export function createActivitySource(ctx: SourceContext): AmbientSource {
  let sub: { remove(): void } | null = null;
  let lastType: string | null = null;

  function handle(event: ActivityEvent): void {
    if (event.type === lastType) return; // 连续同类型去重
    lastType = event.type;
    if (event.confidence === "low") return;
    const summary = `${event.type} (${event.confidence})`;
    ctx.push({
      kind: SIGNAL_KINDS.activity,
      title: "Motion activity",
      summary,
      occurred_at: new Date(event.timestamp).toISOString(),
      payload: {
        schema_version: "activity.v1",
        type: event.type,
        confidence: event.confidence,
      },
    });
    ctx.onEvent("activity", summary);
  }

  return {
    key: "activity",
    label: "Motion activity",
    isStarted: () => sub !== null,
    async start() {
      if (sub) return;
      sub = AmbientVisit.addListener("activity", handle);
      await AmbientVisit.startActivityRecognition();
    },
    async stop() {
      sub?.remove();
      sub = null;
      await AmbientVisit.stopActivityRecognition();
      lastType = null;
    },
  };
}
