interface StateBlockProps {
  title: string;
  detail?: string;
}

export function StateBlock({ title, detail }: StateBlockProps) {
  return (
    <div className="state-block">
      <div className="state-title">{title}</div>
      {detail && <div className="state-detail">{detail}</div>}
    </div>
  );
}
