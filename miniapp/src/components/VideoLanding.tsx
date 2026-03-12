const SparklesIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />
  </svg>
);

const VideoLanding = ({ onGetStarted }: { onGetStarted: () => void }) => (
  <div className="fixed inset-0 z-50 flex flex-col animate-fade-in">
    <video
      src="https://static.pinai.tech/pinclaw/intro-video.mp4"
      autoPlay
      loop
      muted
      playsInline
      className="absolute inset-0 w-full h-full object-cover"
    />
    <div
      className="relative z-10 mt-auto p-6 max-w-md mx-auto w-full"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2.5rem)" }}
    >
      <button
        onClick={onGetStarted}
        className="w-full bg-white/90 text-gray-900 rounded-2xl py-4 text-base font-semibold btn-press shadow-lg flex items-center justify-center gap-2 animate-[breath_2.5s_ease-in-out_infinite] backdrop-blur-sm"
      >
        <SparklesIcon />
        Get Started
      </button>
    </div>
  </div>
);

export default VideoLanding;
