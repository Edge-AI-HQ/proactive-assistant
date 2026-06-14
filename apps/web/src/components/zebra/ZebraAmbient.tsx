import { Radio, Smartphone } from "lucide-react";
import { DeviceConnections, Text } from "@pin-ai/ui-web";

/**
 * Desktop (zebra) AMBIENT — web 端只读语义（设计 SSOT：
 * 2026-05-17-web-cloud-data-self-sufficient + zebra port plan 拍板 3）：
 * 采集发生在手机（native runtime / live session 不进 web），这里呈现
 * 服务端 consent 状态 + 云端已上传的设备数据 timeline（DeviceConnections
 * → DeviceTimeline，与 iOS CONNECT 页同源组件）。
 */
export default function ZebraAmbient({
  ambientOn,
  onConnectMore,
}: {
  ambientOn: boolean;
  onConnectMore: () => void;
}) {
  return (
    <div className="h-full w-full max-w-2xl mx-auto overflow-y-auto px-4 pb-10" style={{ paddingTop: "var(--constellation-header-top, 2.5rem)" }}>
      <h1 className="text-display text-2xl text-foreground mb-1">Ambient</h1>
      <p className="text-sm text-muted-foreground mb-5">What your phone has sensed · uploaded data</p>

      {/* Status card — mirror of the server-side consent (capture runs on the phone) */}
      <div className="glass-card-strong px-4 py-3.5 mb-4 flex items-center gap-3">
        <span className={`relative shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
          ambientOn ? "bg-foreground animate-ambient-icon-breathe" : "bg-foreground/30"
        }`}>
          <Radio size={15} strokeWidth={2} className={ambientOn ? "text-background" : "text-background/60"} />
          {ambientOn && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-background" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <Text variant="bodySm" weight="semibold" className="block text-foreground">
            {ambientOn ? "Ambient sensing is on" : "Ambient sensing is off"}
          </Text>
          <Text variant="label" className="block text-foreground/50 leading-snug">
            Capture happens on your phone — this page mirrors what it has uploaded.
          </Text>
        </div>
        <button
          onClick={onConnectMore}
          className="inline-flex items-center gap-1.5 rounded-xl border border-foreground/10 bg-white/60 px-3 py-2 text-label font-medium text-foreground/70 hover:bg-white/80 transition-colors shrink-0"
        >
          <Smartphone size={13} strokeWidth={1.8} /> Manage on phone
        </button>
      </div>

      {/* Uploaded device data — same component as CONNECT's device section
          (device registry + per-device cloud timeline). */}
      <DeviceConnections />
    </div>
  );
}
