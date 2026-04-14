import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Mic, MicOff } from "lucide-react";

interface VoicePageProps {
  prefill?: string;
  onBack: () => void;
}

export default function VoicePage({ prefill, onBack }: VoicePageProps) {
  const [isListening, setIsListening] = useState(true);
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([
    { role: "ai", text: prefill ? prefill : "I'm listening. How can I help you?" },
  ]);

  const [pulseIntensity, setPulseIntensity] = useState(1);

  useEffect(() => {
    if (!isListening) return;
    const interval = setInterval(() => {
      setPulseIntensity(0.5 + Math.random() * 1.5);
    }, 300);
    return () => clearInterval(interval);
  }, [isListening]);

  const toggleListening = () => {
    if (isListening && transcript) {
      setMessages((prev) => [
        ...prev,
        { role: "user", text: transcript || "..." },
        { role: "ai", text: "Got it. I'll take care of that for you." },
      ]);
      setTranscript("");
    }
    setIsListening(!isListening);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: "100%" }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="absolute inset-0 z-40 flex flex-col h-full"
      style={{
        background: "hsla(220, 30%, 96%, 0.95)",
        backdropFilter: "blur(60px) saturate(1.4)",
        WebkitBackdropFilter: "blur(60px) saturate(1.4)",
      }}
    >
      <div className="flex items-center px-5 pt-6 pb-3">
        <button
          onClick={onBack}
          className="p-2 -ml-2 rounded-full hover:bg-foreground/5 active:bg-foreground/10 transition-colors"
        >
          <ArrowLeft size={20} className="text-foreground" />
        </button>
        <span className="ml-3 text-sm font-medium text-foreground/60 tracking-wide">
          Voice
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        <AnimatePresence>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-foreground text-background rounded-[18px] rounded-br-[4px]"
                    : "glass-card-strong text-foreground/80 rounded-[18px] rounded-bl-[4px]"
                }`}
              >
                {msg.text}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isListening && transcript && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex justify-end"
          >
            <div className="max-w-[80%] px-4 py-2.5 rounded-[18px] rounded-br-[4px] text-sm bg-foreground/5 text-foreground/50 border border-foreground/10">
              {transcript}
              <span className="inline-block w-0.5 h-3.5 bg-foreground/40 ml-0.5 animate-pulse" />
            </div>
          </motion.div>
        )}
      </div>

      <div className="flex flex-col items-center pb-14 pt-6">
        <p className="text-xs text-foreground/40 mb-6 tracking-widest uppercase font-light">
          {isListening ? "Listening..." : "Tap to speak"}
        </p>

        <div className="relative flex items-center justify-center" style={{ width: 120, height: 120 }}>
          {isListening && (
            <>
              <motion.div
                className="absolute rounded-full border border-foreground/10"
                animate={{
                  width: [64, 90 * pulseIntensity],
                  height: [64, 90 * pulseIntensity],
                  opacity: [0.4, 0],
                }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
              />
              <motion.div
                className="absolute rounded-full border border-foreground/8"
                animate={{
                  width: [64, 110 * pulseIntensity],
                  height: [64, 110 * pulseIntensity],
                  opacity: [0.2, 0],
                }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut", delay: 0.3 }}
              />
            </>
          )}

          <motion.button
            onClick={toggleListening}
            className={`relative z-10 w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
              isListening
                ? "bg-foreground text-background shadow-lg"
                : "bg-foreground/10 text-foreground/50"
            }`}
            whileTap={{ scale: 0.9 }}
            style={{
              boxShadow: isListening
                ? "0 8px 32px hsl(var(--foreground) / 0.2)"
                : "none",
            }}
          >
            {isListening ? <Mic size={24} /> : <MicOff size={24} />}
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}
