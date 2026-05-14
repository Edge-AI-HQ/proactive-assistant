interface StateBlockProps {
  title: string;
  detail?: string;
}

export function stateBlockRole(detail: string | undefined): "alert" | "status" {
  return detail ? "alert" : "status";
}

export function stateBlockLiveMode(detail: string | undefined): "assertive" | "polite" {
  return detail ? "assertive" : "polite";
}

export function StateBlock({ title, detail }: StateBlockProps) {
  return (
    <div aria-atomic="true" aria-live={stateBlockLiveMode(detail)} className="state-block" role={stateBlockRole(detail)}>
      <div className="state-title">{title}</div>
      {detail && <div className="state-detail">{detail}</div>}
    </div>
  );
}
