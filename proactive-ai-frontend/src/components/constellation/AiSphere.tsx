import { useCallback, useRef, useEffect } from "react";
import { isNative } from "@/lib/platform";

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
      {isNative ? (
        <div
          className="absolute overflow-hidden rounded-full"
          style={{
            inset: "6%",
            background: [
              "radial-gradient(circle at 42% 34%, rgba(255,255,255,0.82), transparent 28%)",
              "radial-gradient(circle at 58% 64%, rgba(226,116,216,0.35), transparent 36%)",
              "radial-gradient(circle at 38% 58%, rgba(96,176,215,0.25), transparent 42%)",
              "linear-gradient(145deg, rgba(245,247,250,0.92), rgba(232,225,245,0.82))",
            ].join(", "),
            boxShadow: "inset 0 1px 18px rgba(255,255,255,0.85), 0 10px 38px rgba(110,82,132,0.16)",
          }}
        />
      ) : (
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
      )}
    </div>
  );
}
