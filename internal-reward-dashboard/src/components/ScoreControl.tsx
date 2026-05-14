interface ScoreControlProps {
  current: number | null;
  disabled?: boolean;
  onScore: (score: number) => void;
}

function scoreTone(score: number): "low" | "mid" | "high" {
  if (score <= 3) return "low";
  if (score <= 7) return "mid";
  return "high";
}

export function ScoreControl({ current, disabled, onScore }: ScoreControlProps) {
  return (
    <div className="score-grid">
      {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
        <button
          key={score}
          disabled={disabled}
          className={`score-button ${scoreTone(score)} ${current === score ? "active" : ""}`}
          onClick={() => onScore(score)}
          title={`打 ${score} 分`}
          aria-label={`打 ${score} 分`}
        >
          {score}
        </button>
      ))}
    </div>
  );
}
