interface CreateAgentCTAProps {
  onCreateClick?: () => void;
}

const CreateAgentCTA = ({ onCreateClick }: CreateAgentCTAProps) => {
  return (
    <div className="bg-cta-gradient rounded-2xl p-6 text-center border border-primary/10 animate-fade-in">
      <div className="w-20 h-20 mx-auto mb-3 bg-gradient-to-br from-primary to-pin-lavender rounded-full flex items-center justify-center">
        <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1">Create Your Personal AI</h3>
      <p className="text-sm text-muted-foreground mb-5">Deploy your own assistant in 60 seconds</p>
      <button
        onClick={onCreateClick}
        className="w-full bg-primary text-primary-foreground rounded-xl py-3 text-sm font-semibold btn-press shadow-md"
      >
        Create Agent
      </button>
    </div>
  );
};

export default CreateAgentCTA;
