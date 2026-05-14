import { useState, useEffect, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cloud } from "lucide-react";
import { useNavigate } from "react-router-dom";
import AiSphere from "./AiSphere";

const AI_THOUGHTS = [
  "Scanning Gmail…",
  "3 new from Alex",
  "Rai meeting 2pm",
  "Checking Brex",
  "Syncing Slack",
  "Cap table review",
  "HRV trending ↓",
  "Notion synced",
  "Market signals",
  "Systems nominal",
];

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

// Positions tightly around the sphere — all overlap with the orb edge
const THOUGHT_POSITIONS = [
  { x: -70, y: -70 },
  { x: 55, y: -55 },
  { x: -65, y: 40 },
  { x: 60, y: 55 },
  { x: -50, y: -15 },
];

export default function AiLanding() {
  const navigate = useNavigate();

  const handleTapToSpeak = () => {
    navigate("/voice");
  };

  return (
    <div className="relative flex flex-col items-center pt-12 pb-6 px-6">
      {/* Landing overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, hsl(0 0% 100% / 0.88) 0%, hsl(0 0% 100% / 0.82) 50%, hsl(0 0% 100% / 0.5) 85%, transparent 100%)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center w-full">
        {/* Context chips */}
        <div className="flex items-center gap-3 mb-6 w-full">
          <div className="glass-card-strong px-3 py-1.5 flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">23°</span>
            <span className="text-xs text-foreground/70">Rainy</span>
          </div>
          <div className="glass-card-strong px-3 py-1.5 flex items-center justify-center">
            <Cloud size={14} strokeWidth={1.5} className="text-foreground/70" />
          </div>
        </div>

        {/* Greeting */}
        <div className="w-full mb-5" style={{ height: 80 }}>
          <div className="flex gap-2 h-full">
            <GreetingBar />
            <div className="flex-1">
              <h1 className="text-3xl font-light text-foreground leading-tight">
                Hi,{" "}
                <span className="font-semibold bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                  Cherub
                </span>
              </h1>
              <div className="h-[2.8rem] relative mt-1.5">
                <RotatingGreeting />
              </div>
            </div>
          </div>
        </div>

        {/* AI Intelligence Sphere with floating thoughts */}
        <div className="relative flex items-center justify-center mb-2" style={{ width: 320, height: 260 }}>
          {/* Floating AI thoughts around sphere */}
          <FloatingThoughts />

          {/* WebGL Procedural Sphere */}
          <Suspense fallback={<div className="w-[220px] h-[220px] rounded-full bg-foreground/5 animate-pulse" />}>
            <AiSphere size={390} mode="idle" onClick={handleTapToSpeak} />
          </Suspense>

          {/* Drop shadow */}
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{
              bottom: 10,
              width: 100, height: 14,
              background: "radial-gradient(ellipse, hsl(292 50% 60% / 0.12), transparent 70%)",
              filter: "blur(10px)",
            }}
          />
        </div>

        {/* Tap to Speak — always visible, clickable */}
        <motion.button
          onClick={handleTapToSpeak}
          className="flex items-center gap-1.5 mt-5"
          whileTap={{ scale: 0.95 }}
        >
          <span className="text-[11px] text-foreground/40 font-light tracking-wider">
            Tap to Speak
          </span>
        </motion.button>
      </div>
    </div>
  );
}

/** Animated vertical bar that shrinks on exit, grows on enter */
function GreetingBar() {
  const [phase, setPhase] = useState<"show" | "hide">("show");

  useEffect(() => {
    const timer = setInterval(() => {
      setPhase("hide");
      setTimeout(() => setPhase("show"), 450);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <motion.div
      className="w-0.5 bg-foreground/30 rounded-full shrink-0 self-start"
      animate={{ height: phase === "hide" ? 20 : 46 }}
      transition={{ duration: 0.35, ease: "easeInOut" }}
    />
  );
}

function RotatingGreeting() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIdx((prev) => (prev + 1) % AI_GREETINGS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={idx}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
        className="flex items-center gap-2"
      >
        <p className="text-lg text-foreground/85 font-normal leading-relaxed flex-1">
          {AI_GREETINGS[idx]}
        </p>
        <button className="shrink-0 text-foreground/85 hover:text-foreground transition-colors text-lg font-light">
          →
        </button>
      </motion.div>
    </AnimatePresence>
  );
}

/** Floating AI status words that orbit tightly around the sphere */
function FloatingThoughts() {
  const [visibleIdx, setVisibleIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setVisibleIdx((prev) => (prev + 1) % AI_THOUGHTS.length);
    }, 3500);
    return () => clearInterval(timer);
  }, []);

  const thought1 = AI_THOUGHTS[visibleIdx];
  const thought2 = AI_THOUGHTS[(visibleIdx + 3) % AI_THOUGHTS.length];
  const pos1 = THOUGHT_POSITIONS[visibleIdx % THOUGHT_POSITIONS.length];
  const pos2 = THOUGHT_POSITIONS[(visibleIdx + 2) % THOUGHT_POSITIONS.length];

  return (
    <>
      <AnimatePresence mode="wait">
        <motion.span
          key={`t1-${visibleIdx}`}
          className="absolute text-[11px] text-foreground/45 font-normal whitespace-nowrap pointer-events-none z-20"
          style={{
            left: `calc(50% + ${pos1.x}px)`,
            top: `calc(50% + ${pos1.y}px)`,
            transform: "translate(-50%, -50%)",
            textShadow: "0 0 8px hsl(0 0% 100% / 0.8), 0 0 16px hsl(0 0% 100% / 0.4)",
          }}
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
          style={{
            left: `calc(50% + ${pos2.x}px)`,
            top: `calc(50% + ${pos2.y}px)`,
            transform: "translate(-50%, -50%)",
            textShadow: "0 0 8px hsl(0 0% 100% / 0.8), 0 0 16px hsl(0 0% 100% / 0.4)",
          }}
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
