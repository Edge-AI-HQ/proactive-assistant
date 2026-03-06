interface Skill {
  key: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
}

interface AgentSkillsProps {
  skills: Skill[];
  onInstall: (skillKey: string) => void;
  onUninstall: (skillKey: string) => void;
  busy: string;
}

const AgentSkills = ({ skills, onInstall, onUninstall, busy }: AgentSkillsProps) => {
  const installedCount = skills.filter((s) => s.installed).length;
  const displaySkills = skills.slice(0, 4);

  return (
    <div className="glass-card rounded-2xl p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            <span className="title-highlight">Skills</span>
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {installedCount} installed · {skills.length}+ available
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {displaySkills.map((skill) => {
          const installing = busy === `skill-install:${skill.key}`;
          const uninstalling = busy === `skill-uninstall:${skill.key}`;
          return (
            <div
              key={skill.key}
              className="flex items-center gap-2.5 bg-card border border-border/40 rounded-xl px-3 py-2.5 transition-all hover:border-foreground/20"
            >
              <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">{skill.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{skill.description}</p>
              </div>
              {skill.enabled ? (
                <button
                  onClick={() => onUninstall(skill.key)}
                  disabled={busy !== "none"}
                  className="shrink-0 px-2.5 py-1 text-[10px] font-semibold text-foreground bg-secondary/60 rounded-lg btn-press disabled:opacity-50"
                >
                  {uninstalling ? "..." : "Remove"}
                </button>
              ) : (
                <button
                  onClick={() => onInstall(skill.key)}
                  disabled={busy !== "none"}
                  className="shrink-0 px-2.5 py-1 text-[10px] font-semibold bg-foreground text-background rounded-lg btn-press disabled:opacity-50"
                >
                  {installing ? "..." : "Install"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AgentSkills;
