import { motion } from "framer-motion";

/**
 * Lightweight decorative waveform — animated audio-level bars with per-bar
 * phase + amplitude variation so it reads as "listening". Not wired to real
 * mic levels (matches the reference Conversation recording UI); purely visual.
 */
export default function Waveform({ className = "" }: { className?: string }) {
  const BAR_COUNT = 28;
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    // Bias amplitude so the middle of the strip tends to be busier.
    const center = BAR_COUNT / 2;
    const distance = Math.abs(i - center) / center;
    const amplitude = 0.35 + (1 - distance) * 0.55 + ((i * 13) % 7) / 30;
    const delay = (i * 0.06) % 0.9;
    return { amplitude, delay };
  });

  return (
    <div className={`flex items-center justify-center gap-[3px] h-7 ${className}`}>
      {bars.map((b, i) => (
        <motion.span
          key={i}
          className="block w-[2px] rounded-full bg-foreground/70 origin-center"
          style={{ height: 18 }}
          animate={{ scaleY: [0.12, b.amplitude, 0.18, b.amplitude * 0.8, 0.12] }}
          transition={{
            duration: 1.3,
            repeat: Infinity,
            ease: "easeInOut",
            delay: b.delay,
          }}
        />
      ))}
    </div>
  );
}
