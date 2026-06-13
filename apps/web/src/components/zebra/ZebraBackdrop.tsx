import { useState } from "react";
import bgVideo from "@/assets/constellation-bg.mp4";
import bgGradient from "@/assets/bg-gradient.jpg";

/**
 * Shared zebra background — aurora gradient base with the looping video
 * fading in on top once it loads. The video ships in the bundle (downloaded
 * from the Lovable prototype's asset CDN); the aurora layers keep the
 * ambience alive while it streams in.
 */
export default function ZebraBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  return (
    <>
      <div className="absolute inset-0 bg-white" />
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-60"
        aria-hidden="true"
      />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <video
        ref={(el) => { if (el) el.playbackRate = 0.5; }}
        src={bgVideo}
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={() => setVideoReady(true)}
        className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
        style={{ opacity: videoReady ? 0.75 : 0 }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-white/30" />
    </>
  );
}
