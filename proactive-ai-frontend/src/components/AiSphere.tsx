import { useCallback, useRef, useEffect } from "react";

export interface AiSphereProps {
  /** Diameter in px. */
  size?: number;
  /** Visual mode — "thinking" plays the video slightly faster. */
  mode?: "idle" | "thinking";
  className?: string;
  onClick?: () => void;
}

/**
 * Animated AI sphere rendered via a looping video with circular mask
 * and ambient glow effects. The video is composited with `mix-blend-mode: multiply`
 * so the white video background becomes transparent against any page background.
 *
 * Assets expected at `<base>/sphere.webm` and `<base>/sphere.mp4`.
 */
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

  // Vite base path — video lives in public/
  const base = import.meta.env.BASE_URL;

  return (
    <div
      className={`relative ${onClick ? "cursor-pointer" : ""} ${className}`}
      style={{ width: size, height: size }}
      onClick={handleClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* Video sphere — tight mask, soft feathered edge blends naturally
          into the background. No ambient blur/halo: those made the sphere
          look hazy on iOS. */}
      <div
        className="absolute overflow-hidden rounded-full"
        style={{
          inset: "6%",
          WebkitMaskImage:
            "radial-gradient(circle, black 50%, transparent 55%)",
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
          <source src={`${base}sphere.webm`} type="video/webm" />
          <source src={`${base}sphere.mp4`} type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
