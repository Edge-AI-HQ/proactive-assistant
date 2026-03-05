interface TopStatusProps {
  onCreateClick?: () => void;
  hasAgent?: boolean;
}

const TopStatus = ({ hasAgent = false }: TopStatusProps) => {
  return (
    <div className="glass-card rounded-2xl p-5 mx-4 mt-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-[52px] h-[52px] rounded-full bg-gradient-to-br from-primary to-pin-lavender flex items-center justify-center shadow-md">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              <span className="title-highlight">PIN AI Agent Studio</span>
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <svg className="w-3.5 h-3.5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              <span className="text-xs text-muted-foreground">
                {hasAgent ? "1 Active Agent" : "No Agent Yet"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TopStatus;
