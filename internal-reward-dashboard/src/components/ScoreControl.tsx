import { useId } from "react";

interface ScoreControlProps {
  current: number | null;
  disabled?: boolean;
  disabledReason?: string;
  onScore: (score: number) => void;
}

function scoreTone(score: number): "low" | "mid" | "high" {
  if (score <= 3) return "low";
  if (score <= 7) return "mid";
  return "high";
}

export function ScoreControl({ current, disabled, disabledReason, onScore }: ScoreControlProps) {
  const disabledReasonId = useId();
  const showDisabledReason = Boolean(disabled && disabledReason);

  return (
    <div className="score-control">
      <div
        aria-describedby={showDisabledReason ? disabledReasonId : undefined}
        aria-label="人工评分"
        className="score-grid"
        role="group"
      >
        {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
          <button
            key={score}
            aria-pressed={current === score}
            disabled={disabled || current === score}
            className={`score-button ${scoreTone(score)} ${current === score ? "active" : ""}`}
            onClick={() => onScore(score)}
            title={current === score ? `当前 ${score} 分` : `打 ${score} 分`}
            aria-label={current === score ? `当前 ${score} 分` : `打 ${score} 分`}
            type="button"
          >
            {score}
          </button>
        ))}
      </div>
      {showDisabledReason && <div className="muted" id={disabledReasonId}>{disabledReason}</div>}
    </div>
  );
}
