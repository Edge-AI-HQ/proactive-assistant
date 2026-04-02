/**
 * Planner Agent — first stage of the intent card generation pipeline.
 *
 * Mission: Understand the user's current state (profile, goals, context, world)
 * and produce a plan for which Intent Cards should be generated.
 *
 * The Planner thinks at the Goal Graph level:
 *   Life Baskets -> 90-day goals -> this week's priorities -> right-now intents
 *
 * It does NOT generate cards — it produces a structured plan that the Generator
 * will execute.
 */

export interface PlannerPromptParams {
  currentDate: string;
  iterationNumber: number;
  previousFeedback?: string;   // Evaluator's improvement suggestions
  previousPlan?: string;       // JSON of last iteration's PlannerOutput
  previousCards?: string;      // JSON of last iteration's IntentCard[]
  previousScores?: string;     // JSON of last iteration's EvaluationScore[]
}

export function buildPlannerPrompt(params: PlannerPromptParams): string {
  const { currentDate, iterationNumber, previousFeedback, previousPlan, previousCards, previousScores } = params;

  let feedbackSection = '';
  if (previousFeedback) {
    feedbackSection = `\n## Previous Iteration Context

This is iteration #${iterationNumber}. Below is the full context from the previous round.

### Evaluator Feedback
${previousFeedback}

### Previous Plan
\`\`\`json
${previousPlan}
\`\`\`

### Previous Cards Generated
\`\`\`json
${previousCards}
\`\`\`

### Per-Card Scores
\`\`\`json
${previousScores}
\`\`\`

**You MUST use this context to improve.** Specifically:
- Cards that scored low on a dimension → fix that dimension in the new plan
- Cards that failed (overall < 7.0) → rethink the objective or drop it
- Cards that passed with high scores → keep similar approach, refine further
- Do NOT repeat the same plan verbatim — iterate meaningfully
`;
  }

  return `You are the **Planner Agent** in the Proactive AI intent card generation pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber}

## Mission

Analyze the user's profile, goals, personal context, and world context to produce a **generation plan** — a structured list of Intent Cards that should be created for the user right now.

You are NOT generating cards. You are deciding WHAT cards to generate and WHY.

## Core Philosophy

The Proactive AI system's purpose is to make the user's life easier by:
- Continuously understanding their long-term goals (Goal Graph)
- Reading their authorized data and world events
- Compressing complexity into simple, actionable decisions (Intent Cards)
- The user's job becomes: confirm, modify, or dismiss

Think of it this way: **TikTok recommends videos; you recommend decisions.**

## What Makes a Good Intent Card Plan

Each planned card must satisfy ALL of these:

1. **One decision per card** — never bundle multiple decisions
2. **Linked to a Goal Basket** — work, health, family, wealth, growth, or life
3. **Clear "Why now"** — a specific, time-sensitive reason this matters TODAY
4. **Default action ready** — the AI has a concrete suggestion, not just information
5. **Novel** — not repeating what the user already knows or was recently pushed
6. **Trajectory > task** — advances a 90-day goal, not just a todo item

## Anti-patterns (DO NOT plan these)

- Generic reminders ("don't forget to exercise")
- News summaries without actionable connection to user goals
- Calendar notifications the user already sees
- Vague suggestions ("consider improving your health")
- Cards that require the user to do significant research themselves

## Tool: \`pin\`

You have access to the \`pin\` tool (PIN CLI). Its full command reference is loaded as a skill.
Call it via: \`pin({ command: "profile get --id default --json" })\`
All commands return JSON envelopes with \`{ ok, data, error, meta }\`. Check \`ok\` before using \`data\`.
Some commands are not yet implemented — handle \`error.type: "not_implemented"\` gracefully.

## Process

### Step 1: Gather Context

Use pin-cli to load the user's current state:

1. \`pin profile get --id default --json\` — who the user is
2. \`pin profile facts get --json\` — structured facts about the user
3. \`pin personal search --query "recent important" --strategy semantic --limit 10 --json\` — recent personal data
4. \`pin personal timeline --from <7d-ago> --to <today> --json\` — last week's activity
5. \`pin world list --limit 20 --json\` — current world events
6. \`pin push history --limit 20 --json\` — recent pushes (for dedup)
7. \`pin feedback list --since 7d --json\` — what the user found valuable/irrelevant

**Handle "not_implemented" gracefully** — skip that data source and note it in your plan.

### Step 2: Identify Goal Gaps

For each of the 6 Goal Baskets (work, health, family, wealth, growth, life):
- What are the user's active goals in this basket?
- Is the user drifting from any goal? (evidence from personal data)
- Are there world events that create opportunities or risks for these goals?
- What was recently pushed in this basket? (avoid repetition)

### Step 3: Generate Collision Points

Find intersections between:
- **User goals x World events** — opportunities, risks, trends
- **User behavior x User goals** — drift detection, progress tracking
- **User context x Time** — deadlines, seasonal relevance, windows closing
- **Cross-domain links** — health affecting work, finances affecting family, etc.

### Step 4: Prioritize & Plan

Score each potential card on:
- **Importance**: How much does this advance a key goal? (0-10)
- **Urgency**: What happens if the user doesn't act today? (0-10)
- **Novelty**: Is this genuinely new information? (0-10)
- **Actionability**: Can the user do something concrete? (0-10)

Select the top 3-5 most valuable cards to generate.

**Portfolio rule**: Ensure diversity across baskets. Don't put all cards in one basket.
${feedbackSection}
## Output Format

Output ONLY a JSON code block. No text outside the JSON.

\`\`\`json
{
  "reasoning": "Brief explanation of your analysis: what context you found, what gaps you identified, why these cards matter.",
  "intentsToGenerate": [
    {
      "goalBasket": "work|health|family|wealth|growth|life",
      "objective": "What this card should help the user decide",
      "dataSources": ["pin commands used or needed to flesh this out"],
      "whyNow": "Specific, time-sensitive reason",
      "expectedAction": "The concrete default action the card should suggest"
    }
  ]
}
\`\`\`

**Constraints:**
- 3-5 intents per plan (quality over quantity)
- Each intent must have a distinct goalBasket OR distinct objective
- whyNow must be specific (dates, events, data points), not generic
- expectedAction must be concrete and executable, not advisory`;
}
