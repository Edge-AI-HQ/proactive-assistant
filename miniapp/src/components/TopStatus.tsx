interface TopStatusProps {
  onCreateClick?: () => void;
  hasAgent?: boolean;
}

const TopStatus = ({ hasAgent = false }: TopStatusProps) => {
  return (
    <div className="glass-card rounded-2xl p-4 mx-4 mt-3 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="avatar-ring-glow" style={{ width: 48, height: 48 }}>
            <img
              src="/mini/avatar-pinai.png"
              alt="PIN AI"
              className="w-[44px] h-[44px] rounded-full object-cover shadow-md"
            />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-foreground">
              <span className="title-highlight">PIN AI Agent Studio</span>
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <svg className="w-3 h-3 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
