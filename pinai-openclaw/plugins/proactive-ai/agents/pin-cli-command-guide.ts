/**
 * Injected into the unified-generator phase 1 prompt every pipeline run.
 * KEEP THIS IN LOCKSTEP with cli/*.ts and docs/plans/memory-architecture.mdx §六.
 *
 * The guide is the agent's authoritative reference for *what works right
 * now*; aspirational commands belong in docs, not here.
 */
export const PIN_CLI_COMMAND_GUIDE = `
<pin_cli_command_guide>
All commands return a JSON envelope { ok, data, meta, error }. For card
generation and dreaming, context reads must come from local SQLite + folders:
\`pin raw\`, \`pin signals\`, \`pin memory\`, and \`pin profile\`. Composio data
is ingested upstream by connector.init / connector.sync into raw.db and
personal_signals; do not call Composio tools from the generator. Time filters
accept ISO timestamps for --since / --until and integer hours for --hours.

# Long-term picture (画像 + 已沉淀的事实)
- Profile snapshot:      \`pin profile get\`   (singleton profile + goals)
- High-quality memory:   \`pin memory list --quality 0.7 --limit 30\`
- Memory by subject:     \`pin memory list --subjectPrefix person: --limit 20\`
- Memory search:         \`pin memory search --query "投资 偏好" --limit 10\`
                         (also accepts --top as alias of --limit; --since / --until)
- Single memory by id:   \`pin memory get --id <memory_id>\`
- Active skills:         \`pin skills list --status enabled\`
- Skills updated since:  \`pin skills list --updated-since 2026-04-22T00:00:00Z\`
- Show skill body:       \`pin skills show --id <skill_id>\` (cats SKILL.md)

# Right-now context (今天/这周新进的 + 待消化的)
- Recent personal signals:  \`pin signals recent --hours 24 --limit 30\`
- Signals by status:        \`pin signals list --status open --since 2026-04-22T00:00:00Z\`
- Recent emails:            \`pin raw gmail recent --hours 24 --limit 20\`
- Single email thread:      \`pin raw gmail thread --threadId <tid>\`
- Today's calendar:         \`pin raw gcal today\`
- This week's calendar:     \`pin raw gcal week\`
- Calendar list (custom):   \`pin raw gcal list --since 2026-04-23T00:00:00Z --limit 30\`
- Latest installed apps:    \`pin raw device-apps --top 20\`
                            (default = latest snapshot only;
                             pass --since / --until / --deviceId to scope)
- Contact lookup:           \`pin raw device-contacts search --query "张" --deviceId <id>\`
- Contact list (latest):    \`pin raw device-contacts list --limit 200\`
- World news shortlist:     \`pin world shortlist --profile-id default --limit 10\`

# Behaviour history (avoid repetition + learn from feedback)
- Recent feedback:           \`pin feedback list --since 14d\`
- Recent generated cards:    \`pin cards recent --limit 10\`
- Recent dream runs:         \`pin evolution recent --kind daily_dream --limit 3\`
- All evolution runs:        \`pin evolution recent --limit 5\`
- Single run trajectory:     \`pin evolution get --id <run_id>\`
                             (returns refs_consumed / refs_produced — what this run touched)

# Writes (manual sediment / agent-driven evolution)
- Add a memory (positional): \`pin memory add "<text>" --quality 0.6 --subject self\`
- Add a memory (flag form):  \`pin memory add --text "<text>" --source manual --quality 0.7\`
- Archive a memory:          \`pin memory archive --id <memory_id>\`
- Supersede memory:          \`pin memory supersede --old <id> --new <id>\`
- Add a skill:               \`pin skills add --id <id> --title "..." --source manual --from-file SKILL.md\`
- Update skill body:         \`pin skills update --id <id> --from-file SKILL.md\`
- Toggle skill:              \`pin skills disable --id <id>\` / \`pin skills enable --id <id>\`
- Mark a signal consumed:    \`pin signals consume --id <signal_id> --runId <run_id>\`

# Conventions
- Every reader command supports: \`--limit\` (also \`--top\`), \`--since\` / \`--until\`
  (ISO 8601), and a dedicated time shortcut where it makes sense (\`--hours N\`).
- Filters fail loudly when given garbage (e.g. \`--quality 0.7+\` returns
  VALIDATION error, not silent zero rows).
- An empty result is success with \`data.count = 0\` — that itself is a useful
  signal, not an error.

# Disabled surfaces
- Direct Composio tool commands are disabled; generators should never pull
  Composio data directly.
- Behavior history comes from \`pin cards recent\` + \`pin feedback list\`.
- Live user context comes from \`pin signals recent/list\` plus the relevant
  \`pin raw ...\` command.
</pin_cli_command_guide>
`;
