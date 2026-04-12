import { useState, useEffect, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import AiSphere from "./AiSphere";

/** Short status labels that float around the sphere. */
const AI_THOUGHTS = [
  "Scanning Gmail\u2026",
  "3 new from Alex",
  "Meeting at 2pm",
  "Checking Brex",
  "Syncing Slack",
  "Cap table review",
  "HRV trending \u2193",
  "Notion synced",
  "Market signals",
  "Systems nominal",
];

/** Rotating greeting sentences shown below the headline. */
const AI_GREETINGS = [
  "Your 2pm meeting has been moved to 4pm",
  "A follow-up draft has been prepared for Alex",
  "Two threads are waiting for your input",
  "A $34,778 payroll charge just went through",
  "Notes from your last meeting have been organized",
  "A reply has been drafted for the investor email",
  "One decision is pending in your Slack threads",
  "One invoice is still outstanding from Alex",
  "A subscription renewal is coming up tomorrow",
  "Your monthly spend is slightly above average",
  "A transfer has been scheduled for this afternoon",
  "One payment may need your approval",
  "A new transaction looks unusual",
  "Sleep was shorter than usual last night",
  "Your activity level is lower than average today",
  "A workout window is open this afternoon",
  "Your resting heart rate is slightly elevated",
];

/** Positions (px offset from center) for floating thought labels. */
const THOUGHT_POSITIONS = [
  { x: -70, y: -70 },
  { x: 55, y: -55 },
  { x: -65, y: 40 },
  { x: 60, y: 55 },
  { x: -50, y: -15 },
];

const GREETING_ROTATE_MS = 5_000;
const THOUGHT_ROTATE_MS = 3_500;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Animated vertical bar next to the greeting text. */
function GreetingBar() {
  const [phase, setPhase] = useState<"show" | "hide">("show");

  useEffect(() => {
    const id = setInterval(() => {
      setPhase("hide");
      const tid = setTimeout(() => setPhase("show"), 450);
      // Nested timeout is safe — outer interval owns the lifecycle.
      return () => clearTimeout(tid);
    }, GREETING_ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      className="w-0.5 bg-foreground/30 rounded-full shrink-0 self-start"
      animate={{ height: phase === "hide" ? 20 : 46 }}
      transition={{ duration: 0.35, ease: "easeInOut" }}
      aria-hidden="true"
    />
  );
}

/** Cross-fading greeting sentence. */
function RotatingGreeting() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setIdx((prev) => (prev + 1) % AI_GREETINGS.length),
      GREETING_ROTATE_MS,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <AnimatePresence mode="wait">
      <motion.p
        key={idx}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
        className="text-lg text-foreground/85 font-normal leading-relaxed"
      >
        {AI_GREETINGS[idx]}
      </motion.p>
    </AnimatePresence>
  );
}

/** Two floating thought labels that orbit the sphere. */
function FloatingThoughts() {
  const [visibleIdx, setVisibleIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setVisibleIdx((prev) => (prev + 1) % AI_THOUGHTS.length),
      THOUGHT_ROTATE_MS,
    );
    return () => clearInterval(id);
  }, []);

  const thought1 = AI_THOUGHTS[visibleIdx];
  const thought2 = AI_THOUGHTS[(visibleIdx + 3) % AI_THOUGHTS.length];
  const pos1 = THOUGHT_POSITIONS[visibleIdx % THOUGHT_POSITIONS.length];
  const pos2 = THOUGHT_POSITIONS[(visibleIdx + 2) % THOUGHT_POSITIONS.length];

  const chipStyle = (pos: { x: number; y: number }) =>
    ({
      left: `calc(50% + ${pos.x}px)`,
      top: `calc(50% + ${pos.y}px)`,
      transform: "translate(-50%, -50%)",
      textShadow:
        "0 0 8px hsl(0 0% 100% / 0.8), 0 0 16px hsl(0 0% 100% / 0.4)",
    }) as const;

  return (
    <>
      <AnimatePresence mode="wait">
        <motion.span
          key={`t1-${visibleIdx}`}
          className="absolute text-[11px] text-foreground/45 font-normal whitespace-nowrap pointer-events-none z-20"
          style={chipStyle(pos1)}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={{ duration: 1, ease: "easeInOut" }}
        >
          {thought1}
        </motion.span>
      </AnimatePresence>
      <AnimatePresence mode="wait">
        <motion.span
          key={`t2-${visibleIdx}`}
          className="absolute text-[10px] text-foreground/35 font-normal whitespace-nowrap pointer-events-none z-20"
          style={chipStyle(pos2)}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 0.7, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={{ duration: 1, ease: "easeInOut", delay: 0.4 }}
        >
          {thought2}
        </motion.span>
      </AnimatePresence>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface AiLandingProps {
  onTapToSpeak?: () => void;
}

export default function AiLanding({ onTapToSpeak }: AiLandingProps) {
  return (
    <div className="relative flex flex-col items-center pt-3 pb-6 px-6">
      {/* Landing overlay gradient — keeps sphere readable over any bg */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, hsl(0 0% 100% / 0.88) 0%, hsl(0 0% 100% / 0.82) 50%, hsl(0 0% 100% / 0.5) 85%, transparent 100%)",
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 flex flex-col items-center w-full">
        {/* Greeting area */}
        <div className="w-full mb-5" style={{ height: 80 }}>
          <div className="flex gap-2 h-full">
            <GreetingBar />
            <div className="flex-1">
              <h1 className="text-3xl font-light text-foreground leading-tight">
                Hi,{" "}
                <span className="font-semibold bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                  there
                </span>
              </h1>
              <div className="h-[2.8rem] relative mt-1.5">
                <RotatingGreeting />
              </div>
            </div>
          </div>
        </div>

        {/* AI Intelligence Sphere with floating thoughts */}
        <div
          className="relative flex items-center justify-center mb-2"
          style={{ width: 320, height: 260 }}
        >
          <FloatingThoughts />

          <div className="relative z-30">
            <Suspense
              fallback={
                <div className="w-[220px] h-[220px] rounded-full bg-foreground/5 animate-pulse" />
              }
            >
              <AiSphere size={260} mode="idle" onClick={onTapToSpeak} />
            </Suspense>
          </div>

          {/* Drop shadow beneath sphere */}
          <div
            className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
            style={{
              bottom: 10,
              width: 100,
              height: 14,
              background:
                "radial-gradient(ellipse, hsl(292 50% 60% / 0.12), transparent 70%)",
              filter: "blur(10px)",
            }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
