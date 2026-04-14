export const PIN_CLI_COMMAND_GUIDE = `
<pin_cli_command_guide>
When using pin CLI, prefer these exact commands instead of guessing nested subcommands:
- Check available commands: \`pin sys schema --json\`
- Validate a specific nested command before using it: \`pin sys schema push.history --json\`, \`pin sys schema world.shortlist --json\`
- Full profile snapshot: \`pin profile get --id default --full --json\`
- Stable profile facts: \`pin profile facts get --json\`
- Rolled-up profile interests: \`pin profile interests list --id default --kind topic --limit 20 --json\`
- Ranking snapshot: \`pin profile snapshot build --id default --view ranking --json\`
- Personal connections: \`pin personal connections list --json\`
- Personal tool discovery: \`pin personal tools search --query "recent emails" --json\`
- Personal tool schema: \`pin personal tools schema --name GMAIL_FETCH_EMAILS --json\`
- Personal tool execution: \`pin personal exec --tool GMAIL_FETCH_EMAILS --input '{"query":"newer_than:7d","max_results":10,"user_id":"me"}' --json\`
- Recent push history: \`pin push history --since 14d --json\`
- Recent feedback: \`pin feedback list --since 14d --json\`
- Recent generated cards: \`pin cards recent --limit 10 --json\`
- World shortlist: \`pin world shortlist --profile-id default --limit 10 --json\`
- World context for selected ids: \`pin world context --ids world_1,world_2 --json\`
Do not invent aliases like \`pin push list\`, \`pin profile interests\`, \`pin profile snapshot\`, or \`pin profile facts list\`.
</pin_cli_command_guide>
`;
