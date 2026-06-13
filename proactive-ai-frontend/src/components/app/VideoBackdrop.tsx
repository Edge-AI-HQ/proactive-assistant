import bgVideo from "@/assets/constellation-bg.mp4";

/**
 * Shared video background for the main app shell — the NOW home plus every
 * menu sub-page routed inside AppLayout. Structure matches the design repo's
 * VideoBackdrop (Edge-AI-HQ/proactive-pin-ai-c7be7ecc@main): white base →
 * looping video at 0.5× (the subtle motion) → 70% white overlay for
 * readability.
 *
 * Deliberately plays on native too. The rest of the app pauses its CSS
 * aurora / bg-flow animations under `native-power-save` (always on for
 * native — see lib/platform.ts), but this slowed loop IS the new design's
 * "subtly animated" background, so it runs everywhere. Muted + playsInline
 * keeps WKWebView autoplay happy.
 *
 * The static aurora background (bg-gradient.jpg + aurora layers) is kept on
 * the Ask PIN AI surfaces and onboarding — see MinimalistLanding /
 * ConversationView / OnboardingFlow.
 */
export default function VideoBackdrop() {
  return (
    <>
      <div className="absolute inset-0 bg-white" aria-hidden="true" />
      <video
        ref={(el) => {
          if (el) el.playbackRate = 0.5;
        }}
        src={bgVideo}
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-white/70" aria-hidden="true" />
    </>
  );
}
