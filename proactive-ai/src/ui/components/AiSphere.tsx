import { useCallback, useRef, useEffect } from "react";

export interface AiSphereProps {
  size?: number;
  mode?: "idle" | "thinking";
  colorIntensity?: number;
  glowIntensity?: number;
  interactive?: boolean;
  className?: string;
  onClick?: () => void;
}

export default function AiSphere({
  size = 220,
  mode = "idle",
  className = "",
  onClick,
}: AiSphereProps) {
  const handleClick = useCallback(() => onClick?.(), [onClick]);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = mode === "thinking" ? 1.4 : 1;
  }, [mode]);

  return (
    <div
      className={`relative cursor-pointer ${className}`}
      style={{ width: size, height: size }}
      onClick={handleClick}
    >
      {/* Ambient glow */}
      <div
        className="absolute rounded-full animate-pulse"
        style={{
          inset: -24,
          background: "radial-gradient(circle, hsl(320 55% 82% / 0.3) 0%, hsl(300 40% 85% / 0.12) 50%, transparent 72%)",
          filter: "blur(22px)",
        }}
      />

      {/* White halo ring — separates sphere from background */}
      <div
        className="absolute rounded-full"
        style={{
          inset: -2,
         background: "radial-gradient(circle, transparent 68%, hsl(0 0% 100% / 0.25) 74%, hsl(0 0% 100% / 0.4) 79%, hsl(0 0% 100% / 0.15) 85%, transparent 91%)",
          filter: "blur(2px)",
        }}
      />

      {/* Video sphere — circular mask + blend to remove white bg */}
      <div
        className="absolute overflow-hidden rounded-full"
        style={{
          inset: "2%",
          WebkitMaskImage: "radial-gradient(circle, black 64%, transparent 72%)",
          maskImage: "radial-gradient(circle, black 64%, transparent 72%)",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          loop
          muted
          playsInline
          className="w-full h-full object-cover"
          style={{
            mixBlendMode: "multiply",
            transform: "scale(1.05)",
          }}
        >
          <source src="/proactive-ai/assets/sphere.webm" type="video/webm" />
          <source src="/proactive-ai/assets/sphere.mp4" type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
