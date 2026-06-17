import { useState } from "react";
import bgVideo from "@/assets/zebra-bg-pingpong.mp4";

/**
 * Shared zebra background — the ping-pong loop (forward + reversed concatenation
 * so the loop has no jump cut, which is why there's no playbackRate slow-down)
 * under a 65% white overlay for legibility. Ported from the design prototype's
 * ZebraBackdrop; the aurora-gradient base was dropped — the video carries the
 * ambience on its own.
 */
export default function ZebraBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  return (
    <>
      <div className="absolute inset-0 bg-white" />
      <video
        src={bgVideo}
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={() => setVideoReady(true)}
        className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
        style={{ opacity: videoReady ? 1 : 0 }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-white/65" aria-hidden="true" />
    </>
  );
}
