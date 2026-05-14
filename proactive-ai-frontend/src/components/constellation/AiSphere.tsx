import { useCallback, useEffect, useRef } from "react";

export interface AiSphereProps {
  size?: number;
  mode?: "idle" | "thinking";
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
      className={`relative ${onClick ? "cursor-pointer" : ""} ${className}`}
      style={{ width: size, height: size }}
      onClick={handleClick}
    >
      <div
        className="absolute overflow-hidden rounded-full"
        style={{
          inset: "6%",
          WebkitMaskImage: "radial-gradient(circle, black 50%, transparent 55%)",
          maskImage: "radial-gradient(circle, black 50%, transparent 55%)",
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
            imageRendering: "auto",
          }}
        >
          <source src="/sphere.webm" type="video/webm" />
          <source src="/sphere.mp4" type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
